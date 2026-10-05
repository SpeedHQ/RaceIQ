use std::io;
use super::{SourceRecord,RecordKind,encode_live_frame,encode_context_marker,encode_context_end_marker,encode_segment_record};

#[derive(Clone,Debug)] pub struct EncodedCapture { pub bytes:Vec<u8>, pub offsets:Vec<(u64,u64)> }
fn prefix(len:usize,time:Option<u64>,out:&mut Vec<u8>)->io::Result<()> { if len>16*1024*1024{return Err(io::Error::new(io::ErrorKind::InvalidInput,"Frame exceeds capture maximum"));}let n=len as u32;out.extend_from_slice(&(if time.is_some(){n|0x8000_0000}else{n}).to_le_bytes());if let Some(t)=time{out.extend_from_slice(&t.to_le_bytes())}Ok(()) }
fn header()->Vec<u8>{let mut b=Vec::with_capacity(12);b.extend_from_slice(&u32::MAX.to_le_bytes());b.extend_from_slice(&4u32.to_le_bytes());b.extend_from_slice(&0u32.to_le_bytes());b}
/// Re-encode selected records with canonical framing; offsets map source record starts to new starts.
pub fn encode_records(game:&str,records:&[SourceRecord],force_export_deltas:bool)->io::Result<EncodedCapture>{
 let mut bytes=header();let mut offsets=Vec::with_capacity(records.len());let mut previous:Option<Vec<u8>>=None;let mut checkpoint=0u64;let mut group=0u32;let mut in_context=false;
 for r in records {let new_offset=bytes.len() as u64;offsets.push((r.offset,new_offset));match r.kind {
  RecordKind::Segment=>{bytes.extend_from_slice(&encode_segment_record());previous=None;group=0;checkpoint=0;in_context=false;},
  RecordKind::Context=>{if r.payload.is_empty(){if in_context{bytes.extend_from_slice(&encode_context_end_marker());in_context=false;}else{bytes.extend_from_slice(&encode_context_marker());in_context=true;}}else{prefix(r.payload.len(),r.time_ms,&mut bytes)?;bytes.extend_from_slice(&r.payload);}previous=None;group=0;checkpoint=0;},
  RecordKind::Frame=>{let encoded=if let Some(prev)=previous.as_deref(){let result=encode_live_frame(game,&r.payload,new_offset,Some(prev),checkpoint,group)?;if force_export_deltas && (game=="acc"||game=="ac-evo"||game=="lmu") && result.as_slice()==r.payload.as_slice() && group<128 {let d=u32::try_from(new_offset.saturating_sub(checkpoint)).map_err(|_|io::Error::new(io::ErrorKind::InvalidInput,"Offset overflow"))?;match game {"lmu"=>super::encode_lmu(&r.payload,prev,d)?,_=>super::encode_kunos(&r.payload,prev,d)?}} else {result}} else {r.payload.clone()};
   if encoded.as_slice()==r.payload.as_slice()||super::sparse_kind(&encoded).is_none(){checkpoint=new_offset;group=1;}else{group+=1;}
   prefix(encoded.len(),r.time_ms,&mut bytes)?;bytes.extend_from_slice(&encoded);previous=Some(r.payload.clone());
  }
 }}
 let count=records.iter().filter(|r|r.kind==RecordKind::Frame).count() as u32;bytes[8..12].copy_from_slice(&count.to_le_bytes());Ok(EncodedCapture{bytes,offsets})
}
/// Export-only lap policy: checkpoint every 128 source frames; Kunos/LMU deltas are retained even when not smaller.
pub fn encode_lap_slice(game:&str,records:&[SourceRecord])->io::Result<EncodedCapture>{encode_records(game,records,true)}
/// Migration policy applies live sparse acceptance while returning exact remapped record offsets.
pub fn encode_capture_migration(game:&str,records:&[SourceRecord])->io::Result<EncodedCapture>{encode_records(game,records,false)}
