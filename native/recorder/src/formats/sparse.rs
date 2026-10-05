use std::io;

const GENERIC_MAGIC: &[u8; 4] = b"RQSD";
const KUNOS_MAGIC: &[u8; 4] = b"KNSD";
const LMU_MAGIC: &[u8; 4] = b"LMSD";
const LMU_FRAME_MAGIC: &[u8; 8] = b"RQLMUSF\0";
const LMU_HEADER: usize = 28;
const LMU_SHARED: usize = 324_820;
const LMU_SIZE: usize = LMU_HEADER + LMU_SHARED;

fn invalid(s: &str) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, s) }
fn u32at(b: &[u8], n: usize) -> Option<u32> { Some(u32::from_le_bytes(b.get(n..n+4)?.try_into().ok()?)) }
pub fn is_lmu_frame(b: &[u8]) -> bool { b.len() == LMU_SIZE && b.starts_with(LMU_FRAME_MAGIC) }
pub fn kunos_magic(b: &[u8]) -> Option<u32> {
    if b.len() < 24 { return None; }
    let magic=u32at(b,0)?;
    if magic != 0x50434341 && magic != 0x50454341 { return None; }
    let pe=16usize.checked_add(u32at(b,12)? as usize)?;
    if pe.checked_add(8)? > b.len() { return None; }
    let ge=pe.checked_add(4)?.checked_add(u32at(b,pe)? as usize)?;
    if ge.checked_add(4)? > b.len() || ge.checked_add(4)?.checked_add(u32at(b,ge)? as usize)? != b.len() { return None; }
    Some(magic)
}
pub fn generic_identity(b: &[u8]) -> Option<String> {
    if b.len() >= 12 && u32at(b,0)==Some(0x51495249) {
        let version=u16::from_le_bytes(b.get(4..6)?.try_into().ok()?);
        let kind=*b.get(6)?;
        let payload=u32at(b,8)? as usize;
        let limit=if version==2 {256*1024} else {16*1024*1024-12};
        if (version==2 || version==3) && (kind==1||kind==2) && payload>0 && payload<=limit && b.len()==12+payload { return Some(format!("iracing:{version}:{kind}:{}",b.len())); }
        return None;
    }
    if b.len()>=29 && u16::from_le_bytes(b.get(0..2)?.try_into().ok()?)==2025 {
        return Some(format!("f1:{}:{}:{}",hex(&b[..7]),hex(&b[7..15]),b.len()));
    }
    if (324..=400).contains(&b.len()) { return Some(format!("fm:{}",b.len())); }
    None
}
fn hex(b:&[u8])->String { b.iter().map(|v|format!("{v:02x}")).collect() }
fn sparse_encode(magic:&[u8;4], frame:&[u8], prev:&[u8], distance:u32, block:usize, header:usize, lmu:bool)->io::Result<Vec<u8>> {
    if frame.is_empty() || frame.len()>16*1024*1024 || frame.len()!=prev.len() || distance==0 { return Err(invalid("Invalid sparse frame")); }
    let count=if lmu { LMU_SHARED.div_ceil(block) } else { frame.len().div_ceil(block) };
    let bitmap_len=count.div_ceil(8);
    let mut bitmap=vec![0u8;bitmap_len]; let mut size=header+bitmap_len;
    for i in 0..count { let start=if lmu { LMU_HEADER+i*block } else { i*block }; let end=(start+block).min(frame.len());
        if frame[start..end]!=prev[start..end] { bitmap[i/8]|=1<<(i%8); size+=end-start; }
    }
    let mut out=vec![0;size]; out[..4].copy_from_slice(magic);
    if lmu { out[4..8].copy_from_slice(&distance.to_le_bytes()); out[8..8+LMU_HEADER].copy_from_slice(&frame[..LMU_HEADER]); out[8+LMU_HEADER..header+bitmap_len].copy_from_slice(&bitmap); }
    else { out[4..8].copy_from_slice(&distance.to_le_bytes()); if header==13 { out[4]=1; out[5..9].copy_from_slice(&distance.to_le_bytes()); out[9..13].copy_from_slice(&(frame.len() as u32).to_le_bytes()); } else { out[8..12].copy_from_slice(&(frame.len() as u32).to_le_bytes()); } out[header..header+bitmap_len].copy_from_slice(&bitmap); }
    let mut at=header+bitmap_len;
    for i in 0..count { if bitmap[i/8]&(1<<(i%8))==0 { continue; } let start=if lmu { LMU_HEADER+i*block } else { i*block }; let end=(start+block).min(frame.len()); out[at..at+end-start].copy_from_slice(&frame[start..end]); at+=end-start; }
    Ok(out)
}
pub fn encode_generic(frame:&[u8],prev:&[u8],d:u32)->io::Result<Vec<u8>> { if generic_identity(frame).is_none() || generic_identity(frame)!=generic_identity(prev) { return Err(invalid("Invalid generic sparse identity")); } sparse_encode(GENERIC_MAGIC,frame,prev,d,32,13,false) }
pub fn encode_kunos(frame:&[u8],prev:&[u8],d:u32)->io::Result<Vec<u8>> { if kunos_magic(frame).is_none() || kunos_magic(frame)!=kunos_magic(prev) { return Err(invalid("Invalid Kunos sparse identity")); } sparse_encode(KUNOS_MAGIC,frame,prev,d,64,12,false) }
pub fn encode_lmu(frame:&[u8],prev:&[u8],d:u32)->io::Result<Vec<u8>> { if !is_lmu_frame(frame)||!is_lmu_frame(prev) { return Err(invalid("Invalid LMU v2 frame size")); } sparse_encode(LMU_MAGIC,frame,prev,d,64,8+LMU_HEADER,true) }
fn decode(payload:&[u8],prev:&[u8], magic:&[u8;4],block:usize,header:usize,lmu:bool)->io::Result<Vec<u8>> {
    if !payload.starts_with(magic) || (lmu && !is_lmu_frame(prev)) { return Err(invalid("Invalid sparse frame")); }
    let len=if lmu { LMU_SIZE } else if header==13 { u32at(payload,9).ok_or_else(||invalid("Truncated sparse header"))? as usize } else { u32at(payload,8).ok_or_else(||invalid("Truncated sparse header"))? as usize };
    if len==0 || len>16*1024*1024 || prev.len()!=len { return Err(invalid("Invalid sparse length or checkpoint")); }
    if header==13 && payload.get(4)!=Some(&1) { return Err(invalid("Invalid generic sparse version")); }
    let n=if lmu { LMU_SHARED.div_ceil(block) } else { len.div_ceil(block) }; let bm=n.div_ceil(8);
    if payload.len()<header+bm { return Err(invalid("Truncated sparse bitmap")); }
    if n%8!=0 && payload[header+bm-1] & !((1u8<<(n%8))-1)!=0 { return Err(invalid("Invalid sparse bitmap tail")); }
    let mut expected=header+bm;
    for i in 0..n { if payload[header+i/8]&(1<<(i%8))!=0 { expected+=(block).min(if lmu { LMU_SHARED-i*block } else { len-i*block }); } }
    if expected!=payload.len() { return Err(invalid("Invalid sparse payload length")); }
    let mut out=prev.to_vec();
    if lmu { out[..LMU_HEADER].copy_from_slice(&payload[8..8+LMU_HEADER]); }
    let mut at=header+bm;
    for i in 0..n { if payload[header+i/8]&(1<<(i%8))==0 {continue;} let start=if lmu {LMU_HEADER+i*block}else{i*block};let size=block.min(out.len()-start);out[start..start+size].copy_from_slice(&payload[at..at+size]);at+=size; }
    Ok(out)
}
pub fn decode_generic(p:&[u8],prev:&[u8])->io::Result<Vec<u8>> { let out=decode(p,prev,GENERIC_MAGIC,32,13,false)?; if generic_identity(&out)!=generic_identity(prev) {return Err(invalid("Generic sparse identity mismatch"));} Ok(out) }
pub fn decode_kunos(p:&[u8],prev:&[u8])->io::Result<Vec<u8>> { let out=decode(p,prev,KUNOS_MAGIC,64,12,false)?; if kunos_magic(&out)!=kunos_magic(prev) {return Err(invalid("Kunos sparse identity mismatch"));} Ok(out) }
pub fn decode_lmu(p:&[u8],prev:&[u8])->io::Result<Vec<u8>> { decode(p,prev,LMU_MAGIC,64,8+LMU_HEADER,true) }
pub fn sparse_kind(b:&[u8])->Option<&'static str> { if b.starts_with(GENERIC_MAGIC){Some("generic")}else if b.starts_with(KUNOS_MAGIC){Some("kunos")}else if b.starts_with(LMU_MAGIC){Some("lmu")}else{None} }
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generic_round_trip_and_bitmap_tail_validation() {
        let mut a=vec![0;324];a[..2].copy_from_slice(&2025u16.to_le_bytes());
        let mut b=a.clone();b[40]=7;
        let encoded=encode_generic(&b,&a,16).unwrap();
        assert_eq!(decode_generic(&encoded,&a).unwrap(),b);
        let mut malformed=encoded;malformed[14]|=0x80;
        assert!(decode_generic(&malformed,&a).is_err());
    }
    #[test]
    fn kunos_and_lmu_round_trip() {
        let mut a=vec![0;36];a[..4].copy_from_slice(&0x50434341u32.to_le_bytes());a[12..16].copy_from_slice(&4u32.to_le_bytes());a[20..24].copy_from_slice(&4u32.to_le_bytes());a[28..32].copy_from_slice(&4u32.to_le_bytes());
        let mut b=a.clone();b[24]=9;
        assert_eq!(decode_kunos(&encode_kunos(&b,&a,12).unwrap(),&a).unwrap(),b);
        let mut l=vec![0;LMU_SIZE];l[..8].copy_from_slice(LMU_FRAME_MAGIC);let mut changed=l.clone();changed[LMU_HEADER+63]=8;
        assert_eq!(decode_lmu(&encode_lmu(&changed,&l,12).unwrap(),&l).unwrap(),changed);
    }
}
