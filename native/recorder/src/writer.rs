use serde_json::{Value, json};
use std::{borrow::Cow,fs::{self,File,OpenOptions},io::{self,Write,Seek,SeekFrom},path::{Path,PathBuf},time::{SystemTime,UNIX_EPOCH}};
use crate::formats::encode_live_frame;

const META_MAGIC:u32=0xffff_ffff;
fn ioerr(e:io::Error)->String { e.to_string() }
fn framed_len(len:usize,time:Option<u64>)->io::Result<Vec<u8>> {
    if len>16*1024*1024 || (time.is_some_and(|t|t>9_007_199_254_740_991)) { return Err(io::Error::new(io::ErrorKind::InvalidInput,"Invalid capture frame length or timestamp")); }
    let mut p=Vec::with_capacity(if time.is_some(){12}else{4}); let n=len as u32;
    p.extend_from_slice(&(if time.is_some(){n|0x8000_0000}else{n}).to_le_bytes());
    if let Some(t)=time { p.extend_from_slice(&t.to_le_bytes()); } Ok(p)
}
fn meta(count:u32)->[u8;12] { let mut b=[0;12]; b[..4].copy_from_slice(&META_MAGIC.to_le_bytes());b[4..8].copy_from_slice(&4u32.to_le_bytes());b[8..].copy_from_slice(&count.to_le_bytes());b }
fn stamp()->String { let millis=SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();let days=(millis/86_400_000) as i64;let day_ms=millis%86_400_000;let z=days+719468;let era=(if z>=0{z}else{z-146096})/146097;let doe=z-era*146097;let yoe=(doe-doe/1460+doe/36524-doe/146096)/365;let mut y=yoe+era*400;let doy=doe-(365*yoe+yoe/4-yoe/100);let mp=(5*doy+2)/153;let d=doy-(153*mp+2)/5+1;let m=mp+if mp<10{3}else{-9};if m<=2{y+=1}format!("{y:04}-{m:02}-{d:02}T{:02}-{:02}-{:02}-{:03}Z",day_ms/3_600_000,(day_ms/60_000)%60,(day_ms/1000)%60,millis%1000) }
pub struct CaptureWriter { path:PathBuf, file:Option<File>, offset:u64,count:u32,previous:Option<Vec<u8>>,checkpoint_offset:u64,frames_since_checkpoint:u32,game:String,sparse:bool,closed:bool }
impl CaptureWriter {
 pub fn new(root:&Path,game:&str,capture_id:&str)->Result<Self,String> { Self::new_with_policy(root,game,capture_id,true) }
 pub fn new_raw(root:&Path,game:&str,capture_id:&str)->Result<Self,String> { Self::new_with_policy(root,game,capture_id,false) }
 fn new_with_policy(root:&Path,game:&str,capture_id:&str,sparse:bool)->Result<Self,String> {
    if !matches!(game,"fm-2023"|"f1-2025"|"acc"|"ac-evo"|"iracing"|"lmu") { return Err("Unsupported capture game".into()); }
    if capture_id.is_empty() || !capture_id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-') { return Err("Invalid capture ID".into()); }
    let dir=root.join("sessions").join(game); fs::create_dir_all(&dir).map_err(ioerr)?;
    let path=dir.join(format!("{}-{capture_id}.bin",stamp()));
    Ok(Self{path,file:None,offset:12,count:0,previous:None,checkpoint_offset:0,frames_since_checkpoint:0,game:game.to_owned(),sparse,closed:false})
 }
 pub fn path(&self)->&Path { &self.path }
 pub fn current_offset(&self)->u64 { self.offset }
 pub fn preview_offset_for_write(&self,frame:&[u8],time_ms:Option<u64>)->Result<u64,String>{
    if self.closed{return Err("Capture writer is closed".into());}
    let len=if self.sparse {encode_live_frame(&self.game,frame,self.offset,self.previous.as_deref(),self.checkpoint_offset,self.frames_since_checkpoint).map_err(ioerr)?.len()}else{frame.len()};
    let _=framed_len(len,time_ms).map_err(ioerr)?;
    Ok(self.offset)
 }
 pub fn record_count(&self)->u32 { self.count }
 fn open(&mut self)->Result<(),String> { if self.file.is_none(){ let mut f=OpenOptions::new().write(true).read(true).create_new(true).open(&self.path).map_err(ioerr)?; f.write_all(&meta(0)).map_err(ioerr)?;self.file=Some(f);}Ok(()) }
 pub fn write(&mut self,frame:&[u8],time_ms:Option<u64>)->Result<u64,String>{
    if self.closed {return Err("Capture writer is closed".into());}
    let at=self.offset;let encoded:Cow<'_,[u8]>=if self.sparse {Cow::Owned(encode_live_frame(&self.game,frame,at,self.previous.as_deref(),self.checkpoint_offset,self.frames_since_checkpoint).map_err(ioerr)?)}else{Cow::Borrowed(frame)};
    let prefix=framed_len(encoded.len(),time_ms).map_err(ioerr)?;let new_offset=self.offset.checked_add((prefix.len()+encoded.len()) as u64).ok_or("Capture offset overflow")?;let new_count=self.count.checked_add(1).ok_or("Capture frame count overflow")?;
    self.open()?;let f=self.file.as_mut().unwrap();f.write_all(&prefix).and_then(|_|f.write_all(&encoded)).map_err(ioerr)?;
    self.offset=new_offset;self.count=new_count;
    if self.sparse { if encoded.as_ref()==frame || crate::formats::sparse_kind(encoded.as_ref()).is_none() { self.checkpoint_offset=at;self.frames_since_checkpoint=1; } else { self.frames_since_checkpoint+=1; } self.previous=Some(frame.to_vec()); }
    Ok(at)
 }
 pub fn context(&mut self,frame:&[u8])->Result<u64,String>{if self.closed{return Err("Capture writer is closed".into());}if self.file.is_none(){return Ok(self.offset)}let at=self.offset;let prefix=framed_len(frame.len(),None).map_err(ioerr)?;let next=self.offset.checked_add((prefix.len()+frame.len())as u64).ok_or("Capture offset overflow")?;let f=self.file.as_mut().unwrap();f.write_all(&prefix).and_then(|_|f.write_all(frame)).map_err(ioerr)?;self.offset=next;self.previous=None;self.frames_since_checkpoint=0;self.checkpoint_offset=0;Ok(at)}
 pub fn segment(&mut self)->Result<u64,String>{self.marker(crate::formats::encode_segment_record(),true)}
 fn marker(&mut self,b:Vec<u8>,requires_file:bool)->Result<u64,String>{if self.closed{return Err("Capture writer is closed".into());} if requires_file&&self.file.is_none(){return Ok(self.offset)} self.open()?;let at=self.offset;self.file.as_mut().unwrap().write_all(&b).map_err(ioerr)?;self.offset+=b.len() as u64;Ok(at)}
 pub fn flush(&mut self)->Result<(),String>{if let Some(f)=self.file.as_mut(){f.flush().map_err(ioerr)?;}Ok(())}
 pub fn close(&mut self)->Result<Value,String>{if self.closed{return Ok(json!({"path":self.path.to_string_lossy(),"count":self.count,"size":if self.count==0 {0}else{self.offset},"sparse":self.sparse}));}self.closed=true;
    if let Some(mut f)=self.file.take(){f.flush().map_err(ioerr)?;f.seek(SeekFrom::Start(8)).and_then(|_|f.write_all(&self.count.to_le_bytes())).and_then(|_|f.flush()).map_err(ioerr)?;drop(f);}
    Ok(json!({"path":self.path.to_string_lossy(),"count":self.count,"size":if self.count==0 {0}else{self.offset},"sparse":self.sparse}))
 }
}
