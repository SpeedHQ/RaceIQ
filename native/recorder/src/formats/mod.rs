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
/// Payload is valid until the decoder advances; raw frames borrow source bytes.
#[derive(Clone, Copy, Debug)]
pub(crate) struct SourceRecordView<'a> {
    pub offset: u64,
    pub time_ms: Option<u64>,
    pub kind: RecordKind,
    pub payload: &'a [u8],
}
impl SourceRecord {
    pub(crate) fn view(&self) -> SourceRecordView<'_> {
        SourceRecordView { offset: self.offset, time_ms: self.time_ms, kind: self.kind, payload: &self.payload }
    }
}
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
/// Lending decoder: one reusable expanded frame, no retained source-record list.
pub(crate) struct RecordDecoder<'a> {
    bytes: &'a [u8],
    at: usize,
    previous: Option<&'a [u8]>,
    expanded: Vec<u8>,
    expanded_active: bool,
    checkpoint: Option<u64>,
    checkpoint_kind: Option<&'static str>,
    in_context: bool,
}
impl<'a> RecordDecoder<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Self {
        let at = if bytes.len() >= 8 && u32at(bytes, 0) == Some(META) {
            let size = u32at(bytes, 4).unwrap_or(0) as usize;
            8usize.checked_add(size).filter(|end| *end <= bytes.len()).unwrap_or(bytes.len())
        } else { 0 };
        Self { bytes, at, previous: None, expanded: Vec::new(), expanded_active: false,
            checkpoint: None, checkpoint_kind: None, in_context: false }
    }
    fn clear_checkpoint(&mut self) {
        self.previous = None;
        self.expanded_active = false;
        self.checkpoint = None;
        self.checkpoint_kind = None;
    }
    pub(crate) fn next(&mut self) -> Result<Option<SourceRecordView<'_>>, String> {
        while self.at + 4 <= self.bytes.len() {
            let start = self.at as u64;
            if u32at(self.bytes, self.at) == Some(META) {
                if self.at + 8 > self.bytes.len() { break; }
                let size = u32at(self.bytes, self.at + 4).unwrap() as usize;
                let Some(end) = (self.at + 8).checked_add(size).filter(|end| *end <= self.bytes.len()) else { break; };
                let marker = if size == 8 && u32at(self.bytes, self.at + 12) == Some(1) {
                    u32at(self.bytes, self.at + 8)
                } else { None };
                self.at = end;
                if let Some(marker @ (BOUNDARY | CONTEXT | CONTEXT_END)) = marker {
                    self.in_context = marker == CONTEXT;
                    self.clear_checkpoint();
                    return Ok(Some(SourceRecordView { offset: start, time_ms: None,
                        kind: if marker == BOUNDARY { RecordKind::Segment } else { RecordKind::Context }, payload: &[] }));
                }
                continue;
            }
            let Some((len, time_ms, plen)) = prefix(self.bytes, self.at) else { break; };
            let p = self.at + plen;
            let Some(end) = p.checked_add(len).filter(|end| len > 0 && *end <= self.bytes.len()) else { break; };
            let payload: &'a [u8] = &self.bytes[p..end];
            self.at = end;
            let sparse = sparse_kind(payload);
            if let Some(kind) = sparse {
                if !self.expanded_active && self.previous.is_none() {
                    return Err(invalid("Sparse frame has no checkpoint"));
                }
                let back = u32at(payload, if kind == "generic" { 5 } else { 4 }).unwrap_or(0) as u64;
                if back == 0 || back > start || Some(start - back) != self.checkpoint {
                    return Err(invalid("Invalid sparse checkpoint distance"));
                }
                if !self.expanded_active {
                    self.expanded.clear();
                    self.expanded.extend_from_slice(self.previous.unwrap());
                    self.previous = None;
                    self.expanded_active = true;
                }
                sparse::decode_in_place(payload, &mut self.expanded).map_err(|e| e.to_string())?;
                if self.checkpoint_kind.is_some_and(|kind| source_kind(&self.expanded) != Some(kind)) {
                    return Err(invalid("Sparse source identity mismatch"));
                }
            } else {
                self.checkpoint_kind = source_kind(payload);
                self.checkpoint = self.checkpoint_kind.map(|_| start);
                self.previous = Some(payload);
                self.expanded_active = false;
            }
            let kind = if self.in_context {
                self.clear_checkpoint();
                RecordKind::Context
            } else { RecordKind::Frame };
            return Ok(Some(SourceRecordView { offset: start, time_ms, kind,
                payload: if sparse.is_some() { &self.expanded } else { payload } }));
        }
        self.at = self.bytes.len();
        Ok(None)
    }
}
pub fn decode_records(bytes: &[u8]) -> Result<Vec<SourceRecord>, String> {
    let mut decoder = RecordDecoder::new(bytes);
    let mut out = Vec::new();
    while let Some(record) = decoder.next()? {
        out.push(SourceRecord { offset: record.offset, time_ms: record.time_ms,
            kind: record.kind, payload: record.payload.to_vec() });
    }
    Ok(out)
}
pub fn read_capture_bytes(bytes:&[u8])->Result<Vec<SourceRecord>,String>{decode_records(bytes)}
pub fn read_capture(path:&Path)->Result<Vec<SourceRecord>,String>{let mut f=File::open(path).map_err(|e|e.to_string())?;let size=f.metadata().map_err(|e|e.to_string())?.len();if size>MAX_CAPTURE{return Err("Capture exceeds 1 GiB bounded reader limit".into())}let mut bytes=Vec::with_capacity(size as usize);f.read_to_end(&mut bytes).map_err(|e|e.to_string())?;decode_records(&bytes)}

#[cfg(test)]
mod checkpoint_tests {
    use super::*;

    fn append_record(bytes: &mut Vec<u8>, frame: &[u8]) -> u64 {
        let offset = bytes.len() as u64;
        bytes.extend_from_slice(&(frame.len() as u32).to_le_bytes());
        bytes.extend_from_slice(frame);
        offset
    }

    #[test]
    fn sparse_chain_uses_latest_frame_and_original_checkpoint() {
        let first = vec![0; 324];
        let mut second = first.clone();
        second[40] = 7;
        let mut third = second.clone();
        third[80] = 9;
        let mut bytes = Vec::new();
        let first_offset = append_record(&mut bytes, &first);
        let second_offset = bytes.len() as u64;
        let encoded = encode_generic(&second, &first, second_offset as u32).unwrap();
        append_record(&mut bytes, &encoded);
        let third_offset = bytes.len() as u64;
        let encoded = encode_generic(&third, &second, third_offset as u32).unwrap();
        append_record(&mut bytes, &encoded);
        let records = decode_records(&bytes).unwrap();
        assert_eq!(records.iter().map(|r| r.offset).collect::<Vec<_>>(),
                   [first_offset, second_offset, third_offset]);
        assert_eq!(records.into_iter().map(|r| r.payload).collect::<Vec<_>>(),
                   [first, second, third]);
    }

    #[test]
    fn segment_boundary_cannot_reuse_previous_sparse_checkpoint() {
        let first = vec![0; 324];
        let mut next = first.clone();
        next[40] = 7;
        let mut bytes = Vec::new();
        append_record(&mut bytes, &first);
        for value in [META, 8, BOUNDARY, 1] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        let encoded = encode_generic(&next, &first, bytes.len() as u32).unwrap();
        append_record(&mut bytes, &encoded);
        assert_eq!(decode_records(&bytes).unwrap_err(), "Sparse frame has no checkpoint");
    }

    #[test]
    fn lending_decoder_borrows_raw_and_reuses_sparse_storage() {
        let first = vec![0; 324];
        let mut second = first.clone();
        second[40] = 7;
        let mut third = second.clone();
        third[80] = 9;
        let mut bytes = Vec::new();
        append_record(&mut bytes, &first);
        let second_at = bytes.len() as u32;
        append_record(&mut bytes, &encode_generic(&second, &first, second_at).unwrap());
        let third_at = bytes.len() as u32;
        append_record(&mut bytes, &encode_generic(&third, &second, third_at).unwrap());
        let mut decoder = RecordDecoder::new(&bytes);
        let raw = decoder.next().unwrap().unwrap();
        assert_eq!(raw.payload.as_ptr(), bytes[4..].as_ptr());
        assert_eq!(raw.payload, first);
        let sparse = decoder.next().unwrap().unwrap();
        let storage = sparse.payload.as_ptr();
        assert_eq!(sparse.offset, second_at as u64);
        assert_eq!(sparse.payload, second);
        let sparse = decoder.next().unwrap().unwrap();
        assert_eq!(sparse.payload.as_ptr(), storage);
        assert_eq!(sparse.offset, third_at as u64);
        assert_eq!(sparse.payload, third);
        assert!(decoder.next().unwrap().is_none());
    }

    #[test]
    fn context_entry_and_exit_clear_sparse_history() {
        for marker in [encode_context_marker(), encode_context_end_marker(), encode_segment_record()] {
            let first = vec![0; 324];
            let mut next = first.clone();
            next[40] = 7;
            let mut bytes = Vec::new();
            append_record(&mut bytes, &first);
            bytes.extend_from_slice(&marker);
            let at = bytes.len() as u32;
            append_record(&mut bytes, &encode_generic(&next, &first, at).unwrap());
            let mut decoder = RecordDecoder::new(&bytes);
            assert_eq!(decoder.next().unwrap().unwrap().kind, RecordKind::Frame);
            assert!(decoder.next().unwrap().unwrap().payload.is_empty());
            assert_eq!(decoder.next().unwrap_err(), "Sparse frame has no checkpoint");
        }
        let frame = vec![0; 324];
        let mut bytes = Vec::new();
        append_record(&mut bytes, &frame);
        bytes.extend_from_slice(&encode_context_marker());
        append_record(&mut bytes, &frame);
        bytes.extend_from_slice(&encode_context_end_marker());
        let checkpoint = append_record(&mut bytes, &frame);
        let at = bytes.len() as u64;
        let mut next = frame.clone();
        next[80] = 9;
        append_record(&mut bytes, &encode_generic(&next, &frame, (at - checkpoint) as u32).unwrap());
        let records = decode_records(&bytes).unwrap();
        assert_eq!(records[2].kind, RecordKind::Context);
        assert_eq!(records[5].payload, next);
    }

    #[test]
    fn sparse_distance_stays_at_checkpoint_not_previous_delta() {
        let first = vec![0; 324];
        let mut second = first.clone();
        second[40] = 7;
        let mut third = second.clone();
        third[80] = 9;
        let mut bytes = Vec::new();
        append_record(&mut bytes, &first);
        let second_at = bytes.len() as u32;
        append_record(&mut bytes, &encode_generic(&second, &first, second_at).unwrap());
        let third_at = bytes.len() as u32;
        append_record(&mut bytes, &encode_generic(&third, &second, third_at - second_at).unwrap());
        assert_eq!(decode_records(&bytes).unwrap_err(), "Invalid sparse checkpoint distance");
    }

    #[test]
    fn sparse_identity_errors_are_shared_by_owned_and_lending_paths() {
        let mut first = vec![0; 324];
        first[..2].copy_from_slice(&2025u16.to_le_bytes());
        let mut next = first.clone();
        next[20] = 1; // Force the block containing session identity into the delta.
        let mut bytes = Vec::new();
        append_record(&mut bytes, &first);
        let mut delta = encode_generic(&next, &first, bytes.len() as u32).unwrap();
        delta[13 + first.len().div_ceil(32).div_ceil(8) + 7] = 1;
        append_record(&mut bytes, &delta);
        let mut decoder = RecordDecoder::new(&bytes);
        decoder.next().unwrap();
        assert_eq!(decoder.next().unwrap_err(), "Generic sparse identity mismatch");
        assert_eq!(decode_records(&bytes).unwrap_err(), "Generic sparse identity mismatch");
    }

    #[test]
    fn lending_decoder_preserves_timestamps_markers_and_complete_prefixes() {
        let frame = vec![0; 324];
        let mut bytes = Vec::from(META.to_le_bytes());
        bytes.extend_from_slice(&4u32.to_le_bytes());
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(&(0x8000_0000u32 | 324).to_le_bytes());
        bytes.extend_from_slice(&1234u64.to_le_bytes());
        bytes.extend_from_slice(&frame);
        let boundary = bytes.len() as u64;
        bytes.extend_from_slice(&encode_segment_record());
        bytes.extend_from_slice(&100u32.to_le_bytes());
        bytes.extend_from_slice(&[1, 2]); // Incomplete final frame stays outside decoded prefix.
        let mut decoder = RecordDecoder::new(&bytes);
        let first = decoder.next().unwrap().unwrap();
        assert_eq!((first.offset, first.time_ms, first.kind), (12, Some(1234), RecordKind::Frame));
        assert_eq!(first.payload.as_ptr(), bytes[24..].as_ptr());
        let marker = decoder.next().unwrap().unwrap();
        assert_eq!((marker.offset, marker.time_ms, marker.kind), (boundary, None, RecordKind::Segment));
        assert!(decoder.next().unwrap().is_none());
        assert_eq!(decode_records(&bytes).unwrap().len(), 2);
    }
}
