mod sparse;
mod legacy;
pub use legacy::{LegacyCapture,LegacySourceRecord,encode_legacy_source,read_legacy_source};
mod encode;
mod job;
pub use job::run;
pub use encode::{EncodedCapture,encode_capture_migration,encode_lap_slice,encode_records};
pub use sparse::{decode_generic,decode_kunos,decode_lmu,encode_generic,encode_kunos,encode_lmu,generic_identity,is_lmu_frame,kunos_magic,sparse_kind};
use std::{fs::File,io::{self,Read},path::Path};
const META:u32=0xffff_ffff;
const BOUNDARY:u32=0x4d47_4553;
const CONTEXT:u32=0x5854_4753;
const CONTEXT_END:u32=0x454e_4353;
const MAX_CAPTURE:u64=1024*1024*1024;
#[derive(Clone,Copy,Debug,PartialEq,Eq)] pub enum RecordKind { Frame,Context,Segment }
#[derive(Clone,Debug)] pub struct SourceRecord { pub offset:u64,pub time_ms:Option<u64>,pub kind:RecordKind,pub payload:Vec<u8> }
fn u32at(b:&[u8],o:usize)->Option<u32>{Some(u32::from_le_bytes(b.get(o..o+4)?.try_into().ok()?))}
fn invalid(s:&str)->String{s.to_owned()}
fn prefix(b:&[u8],o:usize)->Option<(usize,Option<u64>,usize)>{let raw=u32at(b,o)?;if raw==META{return None}let timed=raw&0x8000_0000!=0;let len=(raw&0x7fff_ffff)as usize;if len>16*1024*1024{return None}let n=if timed{12}else{4};let time=if timed{Some(u64::from_le_bytes(b.get(o+4..o+12)?.try_into().ok()?))}else{None};if time.is_some_and(|x|x>9_007_199_254_740_991){return None}Some((len,time,n))}
pub fn encode_context_marker()->Vec<u8>{let mut v=Vec::with_capacity(16);v.extend_from_slice(&META.to_le_bytes());v.extend_from_slice(&8u32.to_le_bytes());v.extend_from_slice(&CONTEXT.to_le_bytes());v.extend_from_slice(&1u32.to_le_bytes());v}
pub fn encode_context_end_marker()->Vec<u8>{let mut v=Vec::with_capacity(16);v.extend_from_slice(&META.to_le_bytes());v.extend_from_slice(&8u32.to_le_bytes());v.extend_from_slice(&CONTEXT_END.to_le_bytes());v.extend_from_slice(&1u32.to_le_bytes());v}
#[cfg(test)]
mod tests {
 use super::*;
 #[test]
 fn timestamped_frames_and_segment_offsets_round_trip() {
  let mut bytes=vec![0;12];bytes[..4].copy_from_slice(&META.to_le_bytes());bytes[4..8].copy_from_slice(&4u32.to_le_bytes());bytes[8..12].copy_from_slice(&2u32.to_le_bytes());
  let frame=vec![0;324];bytes.extend_from_slice(&(0x8000_0000u32|324).to_le_bytes());bytes.extend_from_slice(&1234u64.to_le_bytes());bytes.extend_from_slice(&frame);
  let segment_at=bytes.len()as u64;bytes.extend_from_slice(&encode_segment_record());let next_at=bytes.len()as u64;bytes.extend_from_slice(&324u32.to_le_bytes());bytes.extend_from_slice(&frame);
  let got=decode_records(&bytes).unwrap();assert_eq!(got.len(),3);assert_eq!(got[0].offset,12);assert_eq!(got[0].time_ms,Some(1234));assert_eq!(got[1].kind,RecordKind::Segment);assert_eq!(got[1].offset,segment_at);assert_eq!(got[2].offset,next_at);
 }
 #[test]
 fn iracing_session_frames_are_samples_unless_explicitly_wrapped_as_context() {
  let mut frame=Vec::from(0x51495249u32.to_le_bytes());
  frame.extend_from_slice(&3u16.to_le_bytes());frame.extend_from_slice(&[1,0]);
  frame.extend_from_slice(&1u32.to_le_bytes());frame.push(0);
  let mut bytes=Vec::from(META.to_le_bytes());bytes.extend_from_slice(&4u32.to_le_bytes());bytes.extend_from_slice(&2u32.to_le_bytes());
  bytes.extend_from_slice(&(frame.len()as u32).to_le_bytes());bytes.extend_from_slice(&frame);
  assert_eq!(decode_records(&bytes).unwrap()[0].kind,RecordKind::Frame);
  let mut context=bytes[..12].to_vec();context.extend_from_slice(&encode_context_marker());context.extend_from_slice(&bytes[12..]);context.extend_from_slice(&encode_context_end_marker());
  let records=decode_records(&context).unwrap();
  assert_eq!(records[1].kind,RecordKind::Context);
  assert_eq!(records[1].payload,frame);
 }
}
pub fn encode_segment_record()->Vec<u8>{let mut v=Vec::with_capacity(16);v.extend_from_slice(&META.to_le_bytes());v.extend_from_slice(&8u32.to_le_bytes());v.extend_from_slice(&BOUNDARY.to_le_bytes());v.extend_from_slice(&1u32.to_le_bytes());v}
pub fn encode_live_frame(game:&str,frame:&[u8],offset:u64,previous:Option<&[u8]>,checkpoint:u64,distance:u32)->io::Result<Vec<u8>>{
 let (kind,valid)=match game {"lmu"=>("lmu",is_lmu_frame(frame)),"acc"=>("kunos",kunos_magic(frame)==Some(0x50434341)),"ac-evo"=>("kunos",kunos_magic(frame)==Some(0x50454341)),"fm-2023"|"f1-2025"|"iracing"=>("generic",generic_identity(frame).is_some()),_=>("raw",false)};
 let Some(prev)=previous else{return Ok(frame.to_vec())};if !valid||prev.len()!=frame.len()||distance>=128{return Ok(frame.to_vec())}
 let d=u32::try_from(offset.saturating_sub(checkpoint)).map_err(|_|io::Error::new(io::ErrorKind::InvalidInput,"Sparse offset overflow"))?;
 let delta=match kind {"lmu"=>encode_lmu(frame,prev,d)?,"kunos"=>encode_kunos(frame,prev,d)?,"generic" if generic_identity(frame)==generic_identity(prev)=>encode_generic(frame,prev,d)?,_=>return Ok(frame.to_vec())};Ok(if delta.len()<frame.len(){delta}else{frame.to_vec()})
}
fn source_kind(frame:&[u8])->Option<&'static str>{if is_lmu_frame(frame){Some("lmu")}else if kunos_magic(frame).is_some(){Some("kunos")}else if generic_identity(frame).is_some(){Some("generic")}else{None}}
pub fn decode_records(bytes:&[u8])->Result<Vec<SourceRecord>,String>{
 let mut out=Vec::new();let mut at=if bytes.len()>=8&&u32at(bytes,0)==Some(META){let plen=u32at(bytes,4).unwrap_or(0)as usize;if 8+plen>bytes.len(){return Ok(out)}8+plen}else{0};
 let(mut previous,mut checkpoint,mut cp_kind):(Option<Vec<u8>>,Option<u64>,Option<&'static str>)=(None,None,None);let mut in_context=false;
 while at+4<=bytes.len(){let start=at as u64;let raw=u32at(bytes,at).unwrap();
  if raw==META{if at+8>bytes.len(){break}let n=u32at(bytes,at+4).unwrap()as usize;if at+8+n>bytes.len(){break}if n==8{let m=u32at(bytes,at+8).unwrap();let ver=u32at(bytes,at+12).unwrap();if m==BOUNDARY&&ver==1{in_context=false;previous=None;checkpoint=None;cp_kind=None;out.push(SourceRecord{offset:start,time_ms:None,kind:RecordKind::Segment,payload:Vec::new()})}else if m==CONTEXT&&ver==1{in_context=true;previous=None;checkpoint=None;cp_kind=None;out.push(SourceRecord{offset:start,time_ms:None,kind:RecordKind::Context,payload:Vec::new()})}else if m==CONTEXT_END&&ver==1{in_context=false;previous=None;checkpoint=None;cp_kind=None;out.push(SourceRecord{offset:start,time_ms:None,kind:RecordKind::Context,payload:Vec::new()})}}at+=8+n;continue}
  let Some((len,time,plen))=prefix(bytes,at)else{break};let p=at+plen;if len==0||p+len>bytes.len(){break}let payload=&bytes[p..p+len];
  let frame=if let Some(kind)=sparse_kind(payload){let prev=previous.as_deref().ok_or_else(||invalid("Sparse frame has no checkpoint"))?;let back=if kind=="generic"{u32at(payload,5)}else{u32at(payload,4)}.unwrap_or(0)as u64;if back==0||back>start||Some(start-back)!=checkpoint{return Err(invalid("Invalid sparse checkpoint distance"))}match kind{"generic"=>decode_generic(payload,prev),"kunos"=>decode_kunos(payload,prev),_=>decode_lmu(payload,prev)}.map_err(|e|e.to_string())?}
  else{let k=source_kind(payload);checkpoint=if k.is_some(){Some(start)}else{None};cp_kind=k;payload.to_vec()};
  if let Some(k)=cp_kind{let got=source_kind(&frame);if got!=Some(k){return Err(invalid("Sparse source identity mismatch"));}}
  let kind=if in_context{previous=None;checkpoint=None;cp_kind=None;RecordKind::Context}else{previous=Some(frame.clone());RecordKind::Frame};
  out.push(SourceRecord{offset:start,time_ms:time,kind,payload:frame});at=p+len;
 }
 Ok(out)
}
pub fn read_capture_bytes(bytes:&[u8])->Result<Vec<SourceRecord>,String>{decode_records(bytes)}
pub fn read_capture(path:&Path)->Result<Vec<SourceRecord>,String>{let mut f=File::open(path).map_err(|e|e.to_string())?;let size=f.metadata().map_err(|e|e.to_string())?.len();if size>MAX_CAPTURE{return Err("Capture exceeds 1 GiB bounded reader limit".into())}let mut bytes=Vec::with_capacity(size as usize);f.read_to_end(&mut bytes).map_err(|e|e.to_string())?;decode_records(&bytes)}
