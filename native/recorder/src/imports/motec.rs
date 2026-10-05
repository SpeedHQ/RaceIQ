use serde_json::{Value,json};
use std::{collections::HashSet,fs,io::{Read,Write},path::Path};
use zip::{ZipArchive,ZipWriter,write::SimpleFileOptions};
const MAX_ARCHIVE:u64=512*1024*1024;const MAX_MEMBER:u64=512*1024*1024;const MAX_TOTAL:u64=768*1024*1024;const MAX_ENTRIES:usize=32;
#[derive(Clone)]struct Channel{name:String,short:String,unit:String,hz:f64,effective:f64,samples:Vec<f64>}
struct Log{device:String,driver:String,vehicle:String,venue:String,date:String,time:String,event_name:String,event_session:String,event_comment:String,duration:f64,channels:Vec<Channel>}
fn u16at(b:&[u8],p:usize)->Result<u16,String>{Ok(u16::from_le_bytes(b.get(p..p+2).ok_or("Truncated MoTeC channel metadata")?.try_into().unwrap()))}fn i16at(b:&[u8],p:usize)->Result<i16,String>{Ok(i16::from_le_bytes(b.get(p..p+2).ok_or("Truncated MoTeC channel metadata")?.try_into().unwrap()))}fn u32at(b:&[u8],p:usize)->Result<u32,String>{Ok(u32::from_le_bytes(b.get(p..p+4).ok_or("Truncated MoTeC header")?.try_into().unwrap()))}
fn latin1_byte(c:u8)->char{const CP:[char;32]=['€','\u{81}','‚','ƒ','„','…','†','‡','ˆ','‰','Š','‹','Œ','\u{8d}','Ž','\u{8f}','\u{90}','‘','’','“','”','•','–','—','˜','™','š','›','œ','\u{9d}','ž','Ÿ'];if (0x80..=0x9f).contains(&c){CP[(c-0x80)as usize]}else{char::from(c)}}
fn text(b:&[u8],p:usize,n:usize)->String{let Some(s)=b.get(p..p.saturating_add(n))else{return String::new()};let e=s.iter().position(|v|*v==0).unwrap_or(s.len());s[..e].iter().map(|c|latin1_byte(*c)).collect::<String>().trim().to_owned()}
fn parse_ld(b:&[u8])->Result<Log,String>{let mp=u32at(b,8)? as usize;if mp==0||mp>=b.len(){return Err("Not a MoTeC .ld file: channel metadata pointer is out of range".into())}let event_ptr=u32at(b,36)? as usize;let has_event=event_ptr>0&&event_ptr<b.len();let mut ptr=mp;let mut seen=HashSet::new();let mut channels=Vec::new();while ptr>0&&ptr.checked_add(124).is_some_and(|e|e<=b.len())&&seen.insert(ptr)&&channels.len()<4096{let count=u32at(b,ptr+12)? as usize;let data=u32at(b,ptr+8)? as usize;let da=u16at(b,ptr+18)?;let dt=u16at(b,ptr+20)?;let hz=u16at(b,ptr+22)? as f64;let shift=i16at(b,ptr+24)? as f64;let mul=i16at(b,ptr+26)? as f64;let scale=i16at(b,ptr+28)? as f64;let dec=i16at(b,ptr+30)? as i32;let float=da==7;let width=if float{if dt==2{2}else{4}}else if dt==3{4}else{2};let n=count.min(b.len().saturating_sub(data)/width);let mut samples=Vec::with_capacity(n);for i in 0..n{let p=data+i*width;let raw=if float{if width==4{f32::from_le_bytes(b[p..p+4].try_into().unwrap())as f64}else{i16at(b,p)?as f64}}else if width==4{i32::from_le_bytes(b[p..p+4].try_into().unwrap())as f64}else{i16at(b,p)?as f64};samples.push(if scale!=1.||mul!=1.||shift!=0.||dec!=0{(raw/if scale==0.{1.}else{scale}*10f64.powi(-dec)+shift)*if mul==0.{1.}else{mul}}else{raw})}channels.push(Channel{name:text(b,ptr+32,32),short:text(b,ptr+64,8),unit:text(b,ptr+72,12),hz,effective:hz,samples});ptr=u32at(b,ptr+4)? as usize}if channels.is_empty(){return Err("MoTeC .ld file contains no channels".into())}let ds=channels.iter().filter(|c|c.hz>0.&&!c.samples.is_empty()).map(|c|c.samples.len()as f64/c.hz).collect::<Vec<_>>();let mut duration=0.;let mut best=0;for x in &ds{let n=ds.iter().filter(|y|(**y-*x).abs()<=*x*0.02).count();if n>best{best=n;duration=*x}}for c in &mut channels{let d=if c.hz>0.{c.samples.len()as f64/c.hz}else{0.};if duration>0.&&(d-duration).abs()>duration*0.05{c.effective=c.samples.len()as f64/duration}}Ok(Log{device:text(b,74,8),driver:text(b,158,64),vehicle:text(b,222,64),venue:text(b,350,64),date:text(b,94,16),time:text(b,126,16),event_name:if has_event{text(b,event_ptr,64)}else{String::new()},event_session:if has_event{text(b,event_ptr+64,64)}else{String::new()},event_comment:if has_event{text(b,event_ptr+128,256)}else{String::new()},duration,channels})}
fn validate_zip_container(bytes:&[u8])->Result<(),String>{
 let window=bytes.len().min(65_557);let start=bytes.len()-window;
 let eocd=(0..=window.saturating_sub(22)).rev().find(|&i|bytes.get(start+i..start+i+4)==Some(&[0x50,0x4b,0x05,0x06])).ok_or("ZIP end-of-central-directory record missing")?;
 let at=start+eocd;let tail=bytes.len()-at;let comment=u16::from_le_bytes(bytes[at+20..at+22].try_into().unwrap())as usize;
 if tail!=22+comment{return Err("Malformed ZIP end-of-central-directory record".into())}
 let disk=u16::from_le_bytes(bytes[at+4..at+6].try_into().unwrap());let central_disk=u16::from_le_bytes(bytes[at+6..at+8].try_into().unwrap());
 let disk_entries=u16::from_le_bytes(bytes[at+8..at+10].try_into().unwrap());let entries=u16::from_le_bytes(bytes[at+10..at+12].try_into().unwrap());
 let central_size=u32::from_le_bytes(bytes[at+12..at+16].try_into().unwrap());let central_offset=u32::from_le_bytes(bytes[at+16..at+20].try_into().unwrap());
 if disk!=0||central_disk!=0||disk_entries!=entries{return Err("Multi-disk ZIP archives are unsupported".into())}
 if entries==u16::MAX||central_size==u32::MAX||central_offset==u32::MAX{return Err("ZIP64 archives are unsupported".into())}
 Ok(())
}
fn beacons(bytes:&[u8])->Vec<f64>{let xml=String::from_utf8_lossy(bytes);let lower=xml.to_ascii_lowercase();let mut out=Vec::new();let mut cursor=0;while let Some(relative)=lower[cursor..].find("<marker"){let start=cursor+relative;let after=start+7;let next=lower.as_bytes().get(after).copied();if next.is_some_and(|c|c.is_ascii_alphanumeric()||c==b'_'||c==b':'){cursor=after;continue}let Some(end_relative)=lower[after..].find('>')else{break};let end=after+end_relative;let tag=&xml[after..end];let tag_lower=&lower[after..end];let mut found=None;for(index,_)in tag_lower.match_indices("time"){let before=index.checked_sub(1).and_then(|i|tag_lower.as_bytes().get(i)).copied();let after=index+4;let next=tag_lower.as_bytes().get(after).copied();if before.is_some_and(|c|c.is_ascii_alphanumeric()||c==b'_'||c==b':')||next.is_some_and(|c|c.is_ascii_alphanumeric()||c==b'_'||c==b':'){continue}let Some(eq)=tag[after..].find('=')else{continue};let value=tag[after+eq+1..].trim_start();if !value.starts_with('"'){continue}if let Some(quote_end)=value[1..].find('"'){if let Ok(micros)=value[1..1+quote_end].parse::<f64>(){if micros.is_finite()&&micros>=0.{found=Some(micros/1_000_000.);break}}}}if let Some(seconds)=found{out.push(seconds)}cursor=end+1}out.sort_by(f64::total_cmp);out.dedup_by(|a,b|a==b);out}
fn pair(path:&Path,name:&str)->Result<(Vec<u8>,Vec<u8>),String>{
 if !name.to_ascii_lowercase().ends_with(".zip"){let ld=fs::read(path).map_err(|e|e.to_string())?;let side=path.with_extension("ldx");let ldx=fs::read(side).map_err(|_|"MoTeC .ldx signal file is required")?;return Ok((ld,ldx))}
 let bytes=fs::read(path).map_err(|e|e.to_string())?;
 if bytes.len()as u64>MAX_ARCHIVE{return Err("MoTeC archive exceeds 512 MiB upload limit".into())}
 validate_zip_container(&bytes)?;
 let mut archive=ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e|format!("Invalid MoTeC ZIP: {e}"))?;
 if archive.len()>MAX_ENTRIES{return Err("MoTeC archive contains too many entries".into())}
 let mut total=0u64;let mut seen=HashSet::new();let(mut ld,mut ldx)=(None,None);
 for i in 0..archive.len(){
  let mut file=archive.by_index(i).map_err(|e|e.to_string())?;
  let name=file.name().to_owned();super::paths::ensure_no_traversal(&name)?;
  let normalized=name.split('/').filter(|part|!part.is_empty()&&*part!=".").collect::<Vec<_>>().join("/");
  if !seen.insert(normalized.clone()){return Err(format!("Duplicate normalized archive path: {name}"))}
  if file.is_dir(){continue}
  let claimed=file.size();if claimed>MAX_MEMBER{return Err("MoTeC ZIP entry exceeds 512 MiB".into())}
  let mut data=Vec::with_capacity(claimed.min(8*1024*1024)as usize);
  (&mut file).take(MAX_MEMBER+1).read_to_end(&mut data).map_err(|e|e.to_string())?;
  let actual=data.len()as u64;if actual>MAX_MEMBER{return Err("MoTeC ZIP entry exceeds 512 MiB".into())}
  total=total.checked_add(actual).ok_or("MoTeC archive size overflow")?;
  if total>MAX_TOTAL{return Err("MoTeC archive exceeds 768 MiB decompressed size limit".into())}
  let lower=normalized.to_ascii_lowercase();
  if lower.ends_with(".ld"){if ld.replace(data).is_some(){return Err("MoTeC ZIP must contain exactly one .ld/.ldx pair".into())}}
  else if lower.ends_with(".ldx"){if ldx.replace(data).is_some(){return Err("MoTeC ZIP must contain exactly one .ld/.ldx pair".into())}}
 }
 Ok((ld.ok_or("MoTeC ZIP must contain exactly one .ld/.ldx pair")?,ldx.ok_or("MoTeC ZIP must contain exactly one .ld/.ldx pair")?))
}
fn load_pair(path:&Path,name:&str,options:&Value,config:&Value)->Result<(Vec<u8>,Vec<u8>,&'static str),String>{
 if name.to_ascii_lowercase().ends_with(".zip"){
  let(ld,ldx)=pair(path,name)?;let bytes=fs::read(path).map_err(|e|e.to_string())?;let mut archive=ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e|format!("Invalid MoTeC ZIP: {e}"))?;
  let mut encoding="legacy-bin-byte-offset";
  for index in 0..archive.len(){let mut entry=archive.by_index(index).map_err(|e|e.to_string())?;if entry.name()!="manifest.json"{continue}
   if entry.size()>1024*1024{return Err("MoTeC source archive manifest exceeds size limit".into())}
   let mut bytes=Vec::new();entry.take(1024*1024+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
   let manifest:Value=serde_json::from_slice(&bytes).map_err(|_|"Invalid MoTeC source archive manifest")?;
   if manifest.get("version").and_then(Value::as_i64)!=Some(1){return Err("Unsupported MoTeC source archive manifest".into())}
   encoding=match manifest.get("offsetEncoding").and_then(Value::as_str){Some("packet-index")=>"packet-index",Some("legacy-bin-byte-offset")=>"legacy-bin-byte-offset",_=>return Err("Unsupported MoTeC source archive manifest".into())};break
  }
  return Ok((ld,ldx,encoding))
 }
 let ld=fs::read(path).map_err(|e|e.to_string())?;
 let root=super::paths::staging_root(config)?;
 let side=if let Some(raw)=options.get("sidecarPath").and_then(Value::as_str){Path::new(raw).to_path_buf()}else{path.with_extension("ldx")};
 let side=side.canonicalize().map_err(|_|"MoTeC .ldx signal file is required")?;
 if !side.starts_with(&root)||!side.is_file(){return Err("MoTeC .ldx sidecar is outside configured staging root".into())}
 let ldx=fs::read(side).map_err(|_|"MoTeC .ldx signal file is required")?;
 Ok((ld,ldx,"packet-index"))
}
fn channel<'a>(log:&'a Log,names:&[&str])->Option<&'a Channel>{log.channels.iter().find(|c|names.iter().any(|n|c.name.eq_ignore_ascii_case(n)))}fn sample(c:Option<&Channel>,t:f64)->f64{let Some(c)=c else{return 0.};if c.samples.is_empty()||c.effective<=0.{return 0.}let index=(t*c.effective).round().clamp(0.,(c.samples.len()-1)as f64)as usize;c.samples[index]}fn safe(v:f64)->Value{if v.is_finite(){json!(v)}else{Value::Null}}fn wheel(log:&Log,base:&str,corner:&str,t:f64)->f64{sample(channel(log,&[&format!("{base}_{corner}")]),t)}
type Point=(f64,f64);
#[derive(Clone,Copy)]struct Transform{scale:f64,rotation:f64,tx:f64,tz:f64}
fn transform_point(p:Point,t:Transform)->Point{let(c,s)=(t.rotation.cos(),t.rotation.sin());(t.scale*(c*p.0-s*p.1)+t.tx,t.scale*(s*p.0+c*p.1)+t.tz)}
fn procrustes(src:&[Point],dst:&[Point])->Transform{let n=src.len().min(dst.len()).max(1)as f64;let (mut sx,mut sz,mut tx,mut tz)=(0.,0.,0.,0.);for(a,b)in src.iter().zip(dst){sx+=a.0;sz+=a.1;tx+=b.0;tz+=b.1}sx/=n;sz/=n;tx/=n;tz/=n;let(mut dot,mut cross,mut norm)=(0.,0.,0.);for(a,b)in src.iter().zip(dst){let(ax,az)=(a.0-sx,a.1-sz);let(bx,bz)=(b.0-tx,b.1-tz);dot+=ax*bx+az*bz;cross+=ax*bz-az*bx;norm+=ax*ax+az*az}let rotation=cross.atan2(dot);let scale=if norm>0.{dot.hypot(cross)/norm}else{1.};let(c,s)=(rotation.cos(),rotation.sin());Transform{scale,rotation,tx:tx-scale*(c*sx-s*sz),tz:tz-scale*(s*sx+c*sz)}}
fn arc(points:&[Point])->Vec<f64>{let mut out=vec![0.;points.len()];for i in 1..points.len(){out[i]=out[i-1]+(points[i].0-points[i-1].0).hypot(points[i].1-points[i-1].1)}let total=*out.last().unwrap_or(&0.);if total>0.{for v in &mut out{*v/=total}}out}
fn arc_sample(points:&[Point],arc:&[f64],count:usize,offset:f64)->Vec<Point>{let mut out=Vec::with_capacity(count);for i in 0..count{let f=(i as f64/count as f64+offset).fract();let idx=arc.partition_point(|v|*v<f).saturating_sub(1).min(points.len().saturating_sub(2));let span=arc.get(idx+1).copied().unwrap_or(1.)-arc[idx];let a=if span>0.{(f-arc[idx])/span}else{0.};out.push((points[idx].0+(points[idx+1].0-points[idx].0)*a,points[idx].1+(points[idx+1].1-points[idx].1)*a))}out}
fn fit_lap(points:&[Point],outline:&[Point])->Option<(Transform,f64)>{if outline.len()<2||points.len()<50{return None}let mut source=Vec::new();for p in points.iter().copied().filter(|p|p.0.is_finite()&&p.1.is_finite()&&*p!=(0.,0.)){if source.last().is_none_or(|q:&Point|(q.0-p.0).powi(2)+(q.1-p.1).powi(2)>=25.){source.push(p)}}if source.len()<50{return None}let n=300.min(source.len()).min(outline.len());let sa=arc(&source);let ta=arc(outline);let ss=arc_sample(&source,&sa,n,0.);let mut best=None;for k in 0..144{let off=k as f64/144.;let ts=arc_sample(outline,&ta,n,off);let mut active=(0..n).collect::<Vec<_>>();let mut fit=procrustes(&ss,&ts);for _ in 0..2{let mut errors=active.iter().map(|i|{let p=transform_point(ss[*i],fit);let q=ts[*i];((p.0-q.0).powi(2)+(p.1-q.1).powi(2),*i)}).collect::<Vec<_>>();errors.sort_by(|a,b|a.0.total_cmp(&b.0));active=errors.into_iter().take((active.len()*4).div_ceil(5).max(3)).map(|x|x.1).collect();fit=procrustes(&active.iter().map(|i|ss[*i]).collect::<Vec<_>>(),&active.iter().map(|i|ts[*i]).collect::<Vec<_>>())}let err=(active.iter().map(|i|{let p=transform_point(ss[*i],fit);let q=ts[*i];(p.0-q.0).powi(2)+(p.1-q.1).powi(2)}).sum::<f64>()/active.len()as f64).sqrt();if best.is_none_or(|(_,e)|err<e){best=Some((fit,err))}}best}
fn outline(options:&Value)->Vec<Point>{options.get("trackOutline").and_then(Value::as_array).map(|points|points.iter().filter_map(|p|Some((p.get("x")?.as_f64()?,p.get("z")?.as_f64()?))).collect()).unwrap_or_default()}
fn fit_paths(x:&mut[f64],z:&mut[f64],vx:&mut[f64],vz:&mut[f64],heading:&mut[f64],lap:&[usize],outline:&[Point],anchor_leading_at_end:bool){
 if outline.len()<2||x.is_empty(){return}let mut start=0;
 for end in 1..=x.len(){if end<x.len()&&lap[end]==lap[start]{continue}
  let positions=(start..end).map(|i|(x[i],z[i])).collect::<Vec<_>>();
  let fit=fit_lap(&positions,outline).filter(|(t,error)|*error<150.&&t.scale>0.&&t.scale<=10.);
  if let Some((transform,_))=fit{for i in start..end{let point=transform_point((x[i],z[i]),transform);x[i]=point.0;z[i]=point.1;let velocity=transform_point((vx[i],vz[i]),Transform{tx:0.,tz:0.,..transform});vx[i]=velocity.0;vz[i]=velocity.1;heading[i]=(heading[i]+transform.rotation).sin().atan2((heading[i]+transform.rotation).cos());}}
  else{let anchor=if start==0&&anchor_leading_at_end{end-1}else{start};let tangent=outline.windows(2).find_map(|pair|{let dx=pair[1].0-pair[0].0;let dz=pair[1].1-pair[0].1;(dx.hypot(dz)>1e-6).then(||dx.atan2(dz))});if let Some(tangent)=tangent{let rotation=tangent-heading[anchor];let(c,s)=(rotation.cos(),rotation.sin());let(ax,az)=(x[anchor],z[anchor]);for i in start..end{let(dx,dz)=(x[i]-ax,z[i]-az);let(ox,oz)=outline[0];x[i]=ox+dx*c+dz*s;z[i]=oz-dx*s+dz*c;let(vx0,vz0)=(vx[i],vz[i]);vx[i]=vx0*c+vz0*s;vz[i]=-vx0*s+vz0*c;heading[i]=(heading[i]+rotation).sin().atan2((heading[i]+rotation).cos());}}}
  start=end;
 }
}
fn missing(log:&Log)->Vec<String>{let req:[(&str,&[&str]);8]=[("SPEED",&["SPEED","GROUND_SPEED","Ground Speed"]),("THROTTLE",&["THROTTLE","Throttle Pos","THROTTLE_POS"]),("BRAKE",&["BRAKE","Brake Pos","BRAKE_POS"]),("STEERANGLE",&["STEERANGLE","STEER_ANGLE","Steering Angle"]),("RPMS",&["RPMS","RPM","Engine RPM","EN_RPM"]),("GEAR",&["GEAR"]),("G_LAT",&["G_LAT","G Force Lat"]),("G_LON",&["G_LON","G Force Long"])];req.iter().filter(|(_,names)|channel(log,names).is_none()).map(|(name,_)|(*name).to_owned()).collect()}
fn synthesize(log:&Log,beacon:&[f64],game:&str,car:i32,track:i32)->Result<Vec<Value>,String>{if log.duration<=0.{return Err("MoTeC log has no usable duration".into())}let n=((log.duration*60.).floor()as usize).max(1);if n>16_000_000{return Err("MoTeC log exceeds synthesized frame limit".into())}let mut bounds=vec![0.];let mut b=beacon.iter().copied().filter(|v|*v>0.&&*v<log.duration).collect::<Vec<_>>();b.sort_by(f64::total_cmp);bounds.extend(b);bounds.push(log.duration);let mut windows=Vec::new();let mut start=0.;for i in 1..bounds.len(){if bounds[i]-start<30.&&i<bounds.len()-1{continue}windows.push((start,bounds[i]));start=bounds[i]}if windows.is_empty(){windows.push((0.,log.duration))}let corners=["LF","RF","LR","RR"];let speed=channel(log,&["SPEED","GROUND_SPEED","Ground Speed"]);let speed_kmh=|t:f64|{let v=sample(speed,t);if speed.is_some_and(|c|c.unit.to_ascii_lowercase().contains("m/s")){v*3.6}else{v}};let throttle=channel(log,&["THROTTLE","Throttle Pos","THROTTLE_POS"]);let brake=channel(log,&["BRAKE","Brake Pos","BRAKE_POS"]);let steer=channel(log,&["STEERANGLE","STEER_ANGLE","Steering Angle"]);let rpm=channel(log,&["RPMS","RPM","Engine RPM","EN_RPM"]);let gear=channel(log,&["GEAR"]);let glat=channel(log,&["G_LAT","G Force Lat"]);let glon=channel(log,&["G_LON","G Force Long"]);let yaw=channel(log,&["ROTY","YAW_RATE"]);let fuel=channel(log,&["FUEL_LEVEL","FUEL","EN_FUEL_LEVEL"]);let mut distance=0.;let mut heading=0.;let(mut x,mut z)=(0.,0.);let mut best=0.;let mut packets=Vec::with_capacity(n);for i in 0..n{let t=i as f64/60.;let lap=windows.iter().position(|w|t<w.1).unwrap_or(windows.len()-1);let lap_start=windows[lap].0;let last=if lap>0{windows[lap-1].1-windows[lap-1].0}else{0.};if last>0.&&(best==0.||last<best){best=last}let sp=speed_kmh(t)/3.6;if i>0{distance+=sp/60.}let yr=sample(yaw,t);heading+=yr/60.;x+=sp*heading.sin()/60.;z+=sp*heading.cos()/60.;let wheels=|base:&str|corners.map(|c|sample(channel(log,&[&format!("{base}_{c}")]),t));let temps=wheels("TYRE_TAIR");let temp=if temps.iter().any(|v|*v!=0.){temps}else{wheels("TYRE_TEMP")};let pressure=wheels("TYRE_PRESS");let brakes=wheels("BRAKE_TEMP");let sus=corners.map(|c|{let v=wheel(log,"SUS_TRAVEL",c,t);let unit=channel(log,&[&format!("SUS_TRAVEL_{c}")]).map(|x|x.unit.as_str()).unwrap_or("");if unit.eq_ignore_ascii_case("mm")||unit.to_ascii_lowercase().starts_with("millimet"){v/1000.}else{v}});let ws=wheels("WHEEL_SPEED");let pedal=|c:Option<&Channel>|{let v=sample(c,t);if c.is_some_and(|x|x.unit.contains('%')){v/100.}else if v>1.{v/100.}else{v}.clamp(0.,1.)};let zero=[0.;4];let tire_detail=if game=="ac-evo"{temp}else{zero};let acc=json!({"tireCompound":if game=="ac-evo"{"dry_compound"}else{""},"tireCoreTemp":tire_detail,"tireInnerTemp":tire_detail,"tireMiddleTemp":tire_detail,"tireOuterTemp":tire_detail,"tireCamber":zero,"wheelLoad":zero,"tireRadius":zero,"tireContactHeading":[[0.,0.,0.],[0.,0.,0.],[0.,0.,0.],[0.,0.,0.]],"brakePadCompound":0,"brakePadWear":if game=="ac-evo"{[-1.;4]}else{zero},"tc":sample(channel(log,&["TC"]),t),"tcCut":0,"abs":sample(channel(log,&["ABS"]),t),"engineMap":0,"brakeBias":Value::Null,"tcIntervention":0,"absIntervention":0,"tcRaw":0,"absRaw":0,"slipVibrations":0,"absVibrations":0,"rainIntensity":0,"trackGripStatus":if game=="ac-evo"{"unknown"}else{""},"windSpeed":0,"windDirection":0,"flagStatus":"","drsAvailable":false,"drsEnabled":false,"pitStatus":"","isValidLap":true,"fuelPerLap":0,"currentSectorIndex":if game=="ac-evo"{-1}else{0},"lastSectorTime":0,"carDamage":{"front":0,"rear":0,"left":0,"right":0,"centre":0}});let mut p=json!({"gameId":game,"IsRaceOn":1,"TimestampMS":0,"EngineMaxRpm":0,"EngineIdleRpm":0,"CurrentEngineRpm":sample(rpm,t),"AccelerationX":sample(glat,t)*9.80665,"AccelerationY":0,"AccelerationZ":sample(glon,t)*9.80665,"VelocityX":sp*heading.sin(),"VelocityY":0,"VelocityZ":sp*heading.cos(),"AngularVelocityX":0,"AngularVelocityY":yr,"AngularVelocityZ":0,"Yaw":-heading,"Pitch":0,"Roll":0,"NormSuspensionTravelFL":0,"NormSuspensionTravelFR":0,"NormSuspensionTravelRL":0,"NormSuspensionTravelRR":0,"TireSlipRatioFL":Value::Null,"TireSlipRatioFR":Value::Null,"TireSlipRatioRL":Value::Null,"TireSlipRatioRR":Value::Null,"WheelRotationSpeedFL":ws[0],"WheelRotationSpeedFR":ws[1],"WheelRotationSpeedRL":ws[2],"WheelRotationSpeedRR":ws[3],"WheelOnRumbleStripFL":0,"WheelOnRumbleStripFR":0,"WheelOnRumbleStripRL":0,"WheelOnRumbleStripRR":0,"WheelInPuddleDepthFL":0,"WheelInPuddleDepthFR":0,"WheelInPuddleDepthRL":0,"WheelInPuddleDepthRR":0,"SurfaceRumbleFL_2":0,"SurfaceRumbleFR_2":0,"SurfaceRumbleRL_2":0,"SurfaceRumbleRR_2":0,"TireSlipCombinedFL_2":0,"TireTempFL":temp[0],"TireTempFR":temp[1],"TireTempRL":temp[2],"TireTempRR":temp[3],"TireCarcassTempFL":if game=="ac-evo"{safe(temp[0])}else{Value::Null},"TireCarcassTempFR":if game=="ac-evo"{safe(temp[1])}else{Value::Null},"TireCarcassTempRL":if game=="ac-evo"{safe(temp[2])}else{Value::Null},"TireCarcassTempRR":if game=="ac-evo"{safe(temp[3])}else{Value::Null},"Boost":0,"Fuel":sample(fuel,t),"DistanceTraveled":distance,"BestLap":best,"LastLap":last,"CurrentLap":t-lap_start,"CurrentRaceTime":if game=="acc"{t}else{t-lap_start},"LapNumber":lap+1,"RacePosition":1,"Accel":(pedal(throttle)*255.).round()as i64,"Brake":(pedal(brake)*255.).round()as i64,"Clutch":0,"HandBrake":0,"Gear":sample(gear,t).round()as i64,"Steer":(-sample(steer,t)/240.*127.).clamp(-127.,127.).round()as i64,"NormDrivingLine":0,"NormAIBrakeDiff":0,"TireWearFL":-1,"TireWearFR":-1,"TireWearRL":-1,"TireWearRR":-1,"SurfaceRumbleFL":0,"SurfaceRumbleFR":0,"SurfaceRumbleRL":0,"SurfaceRumbleRR":0,"TireSlipAngleFL":Value::Null,"TireSlipAngleFR":Value::Null,"TireSlipAngleRL":Value::Null,"TireSlipAngleRR":Value::Null,"TireCombinedSlipFL":Value::Null,"TireCombinedSlipFR":Value::Null,"TireCombinedSlipRL":Value::Null,"TireCombinedSlipRR":Value::Null,"SuspensionTravelMFL":sus[0],"SuspensionTravelMFR":sus[1],"SuspensionTravelMRL":sus[2],"SuspensionTravelMRR":sus[3],"CarOrdinal":car,"carModelName":if game=="ac-evo"{-1}else{0},"CarClass":0,"CarPerformanceIndex":0,"DrivetrainType":if game=="ac-evo"{1}else{0},"NumCylinders":0,"PositionX":x,"PositionY":0,"PositionZ":z,"Speed":sp,"Power":0,"Torque":0,"TrackOrdinal":track,"BrakeTempFrontLeft":brakes[0],"BrakeTempFrontRight":brakes[1],"BrakeTempRearLeft":brakes[2],"BrakeTempRearRight":brakes[3],"TirePressureFrontLeft":pressure[0],"TirePressureFrontRight":pressure[1],"TirePressureRearLeft":pressure[2],"TirePressureRearRight":pressure[3],"WeatherType":0,"TrackTemp":0,"AirTemp":0,"RainPercent":0,"acc":acc});if game=="ac-evo"{p.as_object_mut().unwrap().insert("carModelName".into(),json!(""));}packets.push(p)}Ok(packets)}
fn linear_sample(c:Option<&Channel>,t:f64)->f64{let Some(c)=c else{return 0.};if c.samples.is_empty()||c.effective<=0.{return 0.}let p=(t*c.effective).clamp(0.,(c.samples.len()-1)as f64);let a=p.floor()as usize;let b=(a+1).min(c.samples.len()-1);c.samples[a]*(1.-(p-a as f64))+c.samples[b]*(p-a as f64)}
fn postprocess(log:&Log,packets:&mut[Value],game:&str,outlines:&[Point],leading_at_end:bool){
 if packets.is_empty(){return}let yaw=channel(log,&["ROTY","YAW_RATE"]);let lat=channel(log,&["G_LAT","G Force Lat"]);let glon=channel(log,&["G_LON","G Force Long"]);let speed_ch=channel(log,&["SPEED","GROUND_SPEED","Ground Speed"]);let dt=1./60.;let n=packets.len();let corners=["LF","RF","LR","RR"];
 let kmh=|t:f64|{let v=sample(speed_ch,t);let u=speed_ch.map(|c|c.unit.to_ascii_lowercase()).unwrap_or_default();if u.contains("m/s")||u=="ms"{v*3.6}else if u.contains("mph"){v*1.609344}else{v}};
 let yaw_rad=|t:f64|{let v=linear_sample(yaw,t);if yaw.is_some_and(|c|c.unit.to_ascii_lowercase().contains("deg")||c.unit.contains('°')){v*std::f64::consts::PI/180.}else{v}};
 let lap=packets.iter().map(|p|p.get("LapNumber").and_then(Value::as_u64).unwrap_or(1).saturating_sub(1)as usize).collect::<Vec<_>>();let max_lap=*lap.last().unwrap_or(&0);
 let mut starts=Vec::new();let mut s=0;for i in 1..=n{if i<n&&lap[i]==lap[s]{continue}starts.push((s,i));s=i;}
 let mut bias=vec![0.;starts.len()];if game=="ac-evo"&&yaw.is_some(){for(k,(a,b))in starts.iter().copied().enumerate(){if k==0||k>=max_lap{continue}let start=a as f64*dt;let end=b as f64*dt;if end<=start{continue}let steps=((end-start)/dt).round().max(1.)as usize;let mut integral=0.;for j in 0..steps{let ta=start+j as f64*dt;let tb=(ta+dt).min(end);integral+=(yaw_rad(ta)+yaw_rad(tb))*0.5*(tb-ta)}let full_turn=if integral<0.{-2.*std::f64::consts::PI}else{2.*std::f64::consts::PI};bias[k]=(integral-full_turn)/(end-start)}}
 let reconstructed=if game=="ac-evo"&&yaw.is_some(){let mut h=vec![0.;n];let mut w=0;for i in 1..n{while w+1<starts.len()&&i>=starts[w].1{w+=1}let t=i as f64*dt;let prev=(i-1)as f64*dt;let b=bias[w];h[i]=h[i-1]+((yaw_rad(prev)-b)+(yaw_rad(t)-b))*0.5*dt}Some(h)}else{None};
 let mut x=vec![0.;n];let mut z=x.clone();let mut vx=x.clone();let mut vz=x.clone();let mut head=x.clone();let mut current=0.;let mut last=usize::MAX;let mut lap_window=0;
 for i in 0..n{let t=i as f64*dt;while lap_window+1<starts.len()&&i>=starts[lap_window].1{lap_window+=1}let new_lap=lap[i]!=last;let speed=kmh(t)/3.6;let raw=yaw_rad(t);let has_yaw=yaw.is_some_and(|c|c.samples.iter().any(|v|v.abs()>0.))||game=="ac-evo"&&yaw.is_some();let omega=if game=="ac-evo"&&yaw.is_some(){raw-bias[lap_window]}else if has_yaw{let v=sample(yaw,t);if yaw.is_some_and(|c|c.unit.to_ascii_lowercase().contains("deg")||c.unit.contains('°')){v*std::f64::consts::PI/180.}else{v}}else if speed>3.{sample(lat,t)*9.80665/speed}else{0.};if new_lap{if reconstructed.is_none(){current=0.}last=lap[i]}if let Some(h)=&reconstructed{current=h[i]}else if !new_lap{current+=omega*dt}head[i]=current;vx[i]=current.sin()*speed;vz[i]=current.cos()*speed;if !new_lap&&i>0{x[i]=x[i-1]+vx[i]*dt;z[i]=z[i-1]+vz[i]*dt}}
 if game=="ac-evo"{for(k,(a,b))in starts.iter().copied().enumerate(){if k>0&&k<max_lap&&b>a+1{let(dx,dz)=(x[b-1]-x[a],z[b-1]-z[a]);for j in a..b{let f=(j-a)as f64/(b-1-a)as f64;x[j]-=dx*f;z[j]-=dz*f}}}}
 fit_paths(&mut x,&mut z,&mut vx,&mut vz,&mut head,&lap,outlines,leading_at_end);
 let corners=["LF","RF","LR","RR"];let pedals=[channel(log,&["THROTTLE","Throttle Pos","THROTTLE_POS"]),channel(log,&["BRAKE","Brake Pos","BRAKE_POS"]),channel(log,&["CLUTCH"])];let pedal_scale=pedals.map(|c|c.map(|x|x.samples.iter().fold(0f64,|a,v|a.max(v.abs()))>1.5).unwrap_or(false));let mut susp=corners.map(|c|(0..n).map(|i|sample(channel(log,&[&format!("SUS_TRAVEL_{c}")]),i as f64*dt)).collect::<Vec<_>>());for(c,corner)in corners.iter().enumerate(){let unit=channel(log,&[&format!("SUS_TRAVEL_{corner}")]).map(|x|x.unit.trim().to_ascii_lowercase()).unwrap_or_default();if unit=="mm"||unit.starts_with("millimet"){for v in &mut susp[c]{*v/=1000.}}if game=="ac-evo"{let mean=susp[c].iter().sum::<f64>()/n as f64;for v in &mut susp[c]{*v-=mean}}}
 for(i,p)in packets.iter_mut().enumerate(){let t=i as f64*dt;let Some(o)=p.as_object_mut()else{continue};let sp=kmh(t)/3.6;o.insert("Speed".into(),safe(sp));o.insert("Fuel".into(),safe(sample(channel(log,&["FUEL_LEVEL","FUEL","EN_FUEL_LEVEL"]),t)));o.insert("AngularVelocityY".into(),safe(sample(yaw,t)));o.insert("AccelerationX".into(),safe(sample(lat,t)*9.80665));o.insert("AccelerationZ".into(),safe(sample(glon,t)*9.80665));o.insert("PositionX".into(),safe(x[i]));o.insert("PositionZ".into(),safe(z[i]));o.insert("VelocityX".into(),safe(vx[i]));o.insert("VelocityZ".into(),safe(vz[i]));o.insert("Yaw".into(),safe(-head[i]));for(k,key)in ["Accel","Brake","Clutch"].iter().enumerate(){let v=sample(pedals[k],t)*if pedal_scale[k]{0.01}else{1.};o.insert((*key).into(),json!((v.clamp(0.,1.)*255.).round()as i64));}
  for(corner,j)in ["FL","FR","RL","RR"].iter().zip(0..4){let wheel=|base:&str|sample(channel(log,&[&format!("{base}_{corner}")]),t);let tire=sample(channel(log,&[&format!("TYRE_TAIR_{corner}"),&format!("TYRE_TEMP_{corner}")]),t);let pressure=wheel("TYRE_PRESS");let brake=wheel("BRAKE_TEMP");let ws=wheel("WHEEL_SPEED");let suffix=["FL","FR","RL","RR"][j];o.insert(format!("TireTemp{suffix}"),safe(tire));if game=="ac-evo"{o.insert(format!("TireCarcassTemp{suffix}"),safe(tire));}o.insert(format!("WheelRotationSpeed{suffix}"),safe(ws));o.insert(format!("TirePressure{}",["FrontLeft","FrontRight","RearLeft","RearRight"][j]),safe(pressure));o.insert(format!("BrakeTemp{}",["FrontLeft","FrontRight","RearLeft","RearRight"][j]),safe(brake));o.insert(format!("SuspensionTravelM{}",["FL","FR","RL","RR"][j]),safe(susp[j][i]));}
  let ext=o.get_mut("acc").and_then(Value::as_object_mut).unwrap();ext.insert("tc".into(),safe(sample(channel(log,&["TC"]),t)));ext.insert("abs".into(),safe(sample(channel(log,&["ABS"]),t)));if game=="ac-evo"{let temp=corners.map(|c|sample(channel(log,&[&format!("TYRE_TAIR_{c}"),&format!("TYRE_TEMP_{c}")]),t));for key in ["tireCoreTemp","tireInnerTemp","tireMiddleTemp","tireOuterTemp"]{ext.insert(key.into(),json!(temp));}}
 }
}
pub(super) fn read_packets(path:&Path,options:&Value,config:&Value)->Result<(Vec<Value>,String),String>{
 let name=path.file_name().and_then(|value|value.to_str()).unwrap_or("session.motec.zip");
 let game=options.get("gameId").and_then(Value::as_str).ok_or("MoTeC target game is required")?;
 if game!="acc"&&game!="ac-evo"{return Err("No MoTeC transcoder for requested game".into())}
 let car=options.get("carOrdinal").and_then(Value::as_i64).ok_or("MoTeC car selection is required")?;
 let track=options.get("trackOrdinal").and_then(Value::as_i64).ok_or("MoTeC track selection is required")?;
 if car<0||track<0||car>i32::MAX as i64||track>i32::MAX as i64{return Err("MoTeC car and track selection are required".into())}
 let(ld,ldx,encoding)=load_pair(path,name,options,config)?;let log=parse_ld(&ld)?;
 let mut packets=synthesize(&log,&beacons(&ldx),game,car as i32,track as i32)?;
 let outlines=outline(options);let leading=packets.last().and_then(|p|p.get("LapNumber")).and_then(Value::as_u64).unwrap_or(1)>1;
 postprocess(&log,&mut packets,game,&outlines,leading);
 Ok((packets,encoding.to_owned()))
}
fn run_inner(operation:&str,path:&Path,name:&str,options:&Value,out:&Path,config:&Value)->Result<Value,String>{
 let game=options.get("gameId").and_then(Value::as_str).ok_or("MoTeC target game is required")?;
 if game!="acc"&&game!="ac-evo"{return Err("No MoTeC transcoder for requested game".into())}
 let car=options.get("carOrdinal").and_then(Value::as_i64).ok_or("MoTeC car selection is required")?;
 let track=options.get("trackOrdinal").and_then(Value::as_i64).ok_or("MoTeC track selection is required")?;
 if car<0||track<0||car>i32::MAX as i64||track>i32::MAX as i64{return Err("MoTeC car and track selection are required".into())}
 let(ld,ldx,mut encoding)=load_pair(path,name,options,config)?;
 let log=parse_ld(&ld)?;let mut packets=synthesize(&log,&beacons(&ldx),game,car as i32,track as i32)?;
 let outlines=outline(options);let leading=packets.last().and_then(|p|p.get("LapNumber")).and_then(Value::as_u64).unwrap_or(1)>1;
 postprocess(&log,&mut packets,game,&outlines,leading);
 let (source_path,source_file)=if operation=="reprocess"{
  let raw=options.get("rawFile").and_then(Value::as_str).ok_or("MoTeC reprocess requires original source archive")?;
  let p=super::paths::authorized_capture_path(raw,config)?;
  let archive_name=p.file_name().and_then(|x|x.to_str()).unwrap_or("");
  if !archive_name.to_ascii_lowercase().ends_with(".motec.zip"){return Err("MoTeC reprocess source is not a .motec.zip archive".into())}
  (p.to_string_lossy().into_owned(),Some(p))
 }else if operation=="preview"{(String::new(),None)}else{
  let mut zip=ZipWriter::new(std::io::Cursor::new(Vec::new()));let opt=SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
  zip.start_file("session.ld",opt).map_err(|e|e.to_string())?;zip.write_all(&ld).map_err(|e|e.to_string())?;
  zip.start_file("session.ldx",opt).map_err(|e|e.to_string())?;zip.write_all(&ldx).map_err(|e|e.to_string())?;
  zip.start_file("manifest.json",opt).map_err(|e|e.to_string())?;zip.write_all(br#"{"version":1,"offsetEncoding":"packet-index"}"#).map_err(|e|e.to_string())?;
  let bytes=zip.finish().map_err(|e|e.to_string())?.into_inner();let p=out.join(format!("{}.motec.zip",uuid::Uuid::new_v4()));
  if let Err(error)=fs::write(&p,bytes){let _=fs::remove_file(&p);return Err(error.to_string())}
  encoding="packet-index";(p.to_string_lossy().into_owned(),Some(p))
 };
 let car_catalog=crate::games::catalog::resolve(game,"cars","id",&car.to_string());
 let track_catalog=crate::games::catalog::resolve(game,"tracks","id",&track.to_string());
 let car_track=json!({"carOrdinal":car,"trackOrdinal":track,"carModel":car_catalog.as_ref().and_then(|v|v.get("name")).and_then(Value::as_str).unwrap_or(&log.vehicle),"trackName":track_catalog.as_ref().and_then(|v|v.get("name")).and_then(Value::as_str).unwrap_or(&log.venue)});
 let mut packet_options=options.clone();packet_options["carTrack"]=car_track.clone();packet_options["offsetEncoding"]=json!(encoding);
 let capability_sample=packets.iter().take(2).cloned().collect::<Vec<_>>();
 let yaw=channel(&log,&["ROTY","YAW_RATE"]);
 let yaw_from_lateral=!(game=="ac-evo"&&yaw.is_some())&&!yaw.is_some_and(|c|c.samples.iter().any(|x|x.abs()>0.));
 let missing_channels=missing(&log);
 let mut result=match super::capture::process_packets(operation,packets,name,&packet_options,source_file.as_deref()){
  Ok(result)=>result,
  Err(error)=>{
   if operation!="reprocess"{if let Some(path)=source_file.as_ref(){let _=fs::remove_file(path);}}
   return Err(error);
  }
 };
 if let Some(obj)=result.as_object_mut(){
  obj.insert("meta".into(),json!({"device":log.device,"driver":log.driver,"eventName":log.event_name,"eventSession":log.event_session,"eventComment":log.event_comment,"venue":log.venue,"vehicleId":log.vehicle,"date":log.date,"time":log.time,"duration":log.duration}));
  obj.insert("carTrack".into(),car_track);obj.insert("sampleRates".into(),json!(log.channels.iter().map(|c|json!({"name":c.name,"shortName":c.short,"unit":c.unit,"hz":c.effective})).collect::<Vec<_>>()));
  obj.insert("missingChannels".into(),json!(missing_channels));obj.insert("yawFromLateralG".into(),json!(yaw_from_lateral));
  obj.insert("limitations".into(),json!([
   "Racing line is drawn from an estimated path: speed is integrated using logged yaw rate, with lateral G force as the fallback when yaw is unavailable. It can drift, so use it to compare lap shape — not exact track position.",
   "Steering is normalised against an assumed 240° lock — MoTeC does not export the car's steering lock.",
   "Suspension and wheel-speed channels are logged by MoTeC at 200 Hz and are resampled down to 60 Hz.",
   "Sector times are recomputed from track geometry, not read from the log."
  ]));
  obj.insert("capabilitySample".into(),json!(capability_sample));
  if operation=="preview"{obj.insert("sourceArchivePath".into(),Value::Null);}else{obj.insert("sourceArchivePath".into(),json!(source_path));}
 }
 Ok(result)
}
pub(super) fn run(operation:&str,path:&Path,name:&str,options:&Value,out:&Path,config:&Value)->Result<Value,String>{run_inner(operation,path,name,options,out,config)}
pub(super) fn member(operation:&str,bytes:&[u8],name:&str,options:&Value,out:&Path,config:&Value)->Result<Value,String>{let path=out.join(format!("input-{}",uuid::Uuid::new_v4()));fs::write(&path,bytes).map_err(|e|e.to_string())?;let result=run_inner(operation,&path,name,options,out,config);let _=fs::remove_file(path);result}
