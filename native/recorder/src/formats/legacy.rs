use std::io;
const KUNOS:&[u8;8]=b"ACCTEST\0";
const IRACING:&[u8;8]=b"IRIQDMP\0";
const LMU:&[u8;8]=b"LMUQDMP\0";
#[derive(Clone,Debug,PartialEq,Eq)] pub struct LegacySourceRecord { pub offset:u64,pub source_type:u8,pub payload:Vec<u8> }
#[derive(Clone,Debug,PartialEq,Eq)] pub struct LegacyCapture { pub game:&'static str,pub version:u32,pub records:Vec<LegacySourceRecord> }
fn u32at(b:&[u8],p:usize)->Option<u32>{Some(u32::from_le_bytes(b.get(p..p+4)?.try_into().ok()?))}
/// Reads ACCTEST v2/v3, IRIQDMP v2, and LMUQDMP v1 complete prefixes.
pub fn read_legacy_source(bytes:&[u8])->Result<Option<LegacyCapture>,String>{
 if bytes.len()<16{return Ok(None)}
 let(game,versions,max):(&'static str,&[u32],usize)=if bytes.starts_with(KUNOS){("acc",&[2,3],16*1024*1024)}else if bytes.starts_with(IRACING){("iracing",&[2],16*1024*1024)}else if bytes.starts_with(LMU){("lmu",&[1],324_848)}else{return Ok(None)};
 let version=u32at(bytes,8).unwrap();if !versions.contains(&version){return Ok(None)}let declared=u32at(bytes,12).unwrap();let mut at=16usize;let mut records=Vec::new();
 while (declared==0||records.len()<declared as usize)&&at+5<=bytes.len(){let record_offset=at as u64;let source_type=bytes[at];let size=u32at(bytes,at+1).unwrap()as usize;at+=5;if (size==0&&game!="acc")||size>max||at.checked_add(size).is_none_or(|end|end>bytes.len()){break}if game!="acc"&&source_type!=0{break}records.push(LegacySourceRecord{offset:record_offset,source_type,payload:bytes[at..at+size].to_vec()});at+=size;}
 Ok(Some(LegacyCapture{game,version,records}))
}
pub fn encode_legacy_source(capture:&LegacyCapture)->io::Result<Vec<u8>>{
 let(magic,version):(&[u8;8],u32)=match(capture.game,capture.version){("acc",2|3)=>(KUNOS,capture.version),("iracing",2)=>(IRACING,2),("lmu",1)=>(LMU,1),_=>return Err(io::Error::new(io::ErrorKind::InvalidInput,"Unsupported legacy capture format"))};
 let mut out=Vec::new();out.extend_from_slice(magic);out.extend_from_slice(&version.to_le_bytes());out.extend_from_slice(&(capture.records.len()as u32).to_le_bytes());
 for r in &capture.records{if (r.payload.is_empty()&&capture.game!="acc")||r.payload.len()>u32::MAX as usize{return Err(io::Error::new(io::ErrorKind::InvalidInput,"Invalid legacy source record"));}out.push(r.source_type);out.extend_from_slice(&(r.payload.len()as u32).to_le_bytes());out.extend_from_slice(&r.payload);}
 Ok(out)
}
