use serde_json::{json, Map, Value};
use std::{collections::HashMap, fs::File, io::{Read, Seek, SeekFrom}, path::Path};

const HEADER: u64 = 144;
const VAR_HEADER: usize = 144;
const MAX_VARIABLES: i32 = 4096;
const MAX_ROW: i32 = 4 * 1024 * 1024;
const MAX_SESSION: i32 = 4 * 1024 * 1024;
const MAX_FILE: u64 = 8 * 1024 * 1024 * 1024;
const REQUIRED: [&str; 7] = ["SessionTime", "SessionNum", "IsOnTrack", "Speed", "Lap", "LapLastLapTime", "LapCurrentLapTime"];

#[derive(Clone)] struct Desc { ty:i32, offset:usize, count:usize, name:String }
struct Layout { size:u64, tick:i32, row:usize, count:u64, data:u64, date:i64, start:f64, end:f64, lap_count:i32, trailing:u64, yaml:String, desc:Vec<Desc>, by_name:HashMap<String,Desc> }
fn cstr(b:&[u8])->String { let end=b.iter().position(|x|*x==0).unwrap_or(b.len()); String::from_utf8_lossy(&b[..end]).trim().to_owned() }
fn read_at(f:&mut File, at:u64, buf:&mut [u8])->Result<(),String>{f.seek(SeekFrom::Start(at)).map_err(|e|format!("Seek IBT: {e}"))?;f.read_exact(buf).map_err(|e|format!("Unexpected end of iRacing IBT at byte {at}: {e}"))}
fn i32at(b:&[u8],o:usize)->Result<i32,String>{Ok(i32::from_le_bytes(b.get(o..o+4).ok_or("Invalid iRacing IBT header")?.try_into().unwrap()))}
fn layout(path:&Path)->Result<(File,Layout),String>{
 let mut f=File::open(path).map_err(|e|format!("Open iRacing IBT: {e}"))?;let size=f.metadata().map_err(|e|format!("Read IBT metadata: {e}"))?.len();if size>MAX_FILE{return Err("iRacing IBT exceeds 8 GiB limit".into())}if size<HEADER{return Err("Invalid iRacing IBT header".into())}
 let mut h=[0u8;HEADER as usize];read_at(&mut f,0,&mut h)?;
 let version=i32at(&h,0)?;let tick=i32at(&h,8)?;let sl=i32at(&h,16)?;let so=i32at(&h,20)?;let n=i32at(&h,24)?;let vo=i32at(&h,28)?;let buffers=i32at(&h,32)?;let row=i32at(&h,36)?;let date=i64::from_le_bytes(h[112..120].try_into().unwrap());let start=f64::from_le_bytes(h[120..128].try_into().unwrap());let end=f64::from_le_bytes(h[128..136].try_into().unwrap());let laps=i32at(&h,136)?;let records=i32at(&h,140)?;
 if version<=0||tick<=0||tick>1000||sl<=0||sl>MAX_SESSION||n<=0||n>MAX_VARIABLES||buffers<=0||buffers>4||row<=0||row>MAX_ROW||laps<0||records<0||!start.is_finite()||!end.is_finite()||date<0{return Err("Invalid iRacing IBT header values".into())}
 let vlen=(n as u64).checked_mul(VAR_HEADER as u64).ok_or("IBT variable table size overflow")?;let vend=(vo as u64).checked_add(vlen).ok_or("IBT variable table range overflow")?;let send=(so as u64).checked_add(sl as u64).ok_or("IBT session info range overflow")?;
 if vo<HEADER as i32||so<0||vend>so as u64||send>size||vend>size{return Err("Invalid iRacing IBT metadata layout".into())}
 let data=send;let expected=data.checked_add((records as u64).checked_mul(row as u64).ok_or("IBT telemetry length overflow")?).ok_or("IBT expected file size overflow")?;if expected>size{return Err(format!("Truncated iRacing IBT: expected at least {expected} bytes, found {size}"))}
 let mut vb=vec![0u8;vlen as usize];read_at(&mut f,vo as u64,&mut vb)?;let mut desc=Vec::new();let mut by_name=HashMap::new();
 for x in vb.chunks_exact(VAR_HEADER){let ty=i32at(x,0)?;let off=i32at(x,4)?;let cnt=i32at(x,8)?;let unit=match ty{0|1=>1,2|3|4=>4,5=>8,_=>0};let name=cstr(&x[16..48]);if name.is_empty()||unit==0||off<0||cnt<=0||cnt>4096||(off as u64).checked_add((unit*cnt) as u64).is_none_or(|e|e>row as u64){continue}let d=Desc{ty,offset:off as usize,count:cnt as usize,name:name.clone()};by_name.insert(name,d.clone());desc.push(d)}
 let mut y=vec![0u8;sl as usize];read_at(&mut f,so as u64,&mut y)?;let ylen=y.iter().position(|x|*x==0).unwrap_or(y.len());let yaml=String::from_utf8_lossy(&y[..ylen]).to_string();if yaml.trim().is_empty(){return Err("iRacing IBT session information is empty".into())}
 Ok((f,Layout{size,tick,row:row as usize,count:records as u64,data,date,start,end,lap_count:laps,trailing:size-expected,yaml,desc,by_name}))
}
fn read_value(d:&Desc,row:&[u8])->Value {if d.ty==0{let b=&row[d.offset..d.offset+d.count];let end=b.iter().position(|x|*x==0).unwrap_or(b.len());return json!(String::from_utf8_lossy(&b[..end]))}let one=|i:usize|->Value{let o=d.offset+i*match d.ty{1=>1,2|3|4=>4,_=>8};match d.ty{1=>json!(row[o]!=0),2=>json!(i32::from_le_bytes(row[o..o+4].try_into().unwrap())),3=>json!(u32::from_le_bytes(row[o..o+4].try_into().unwrap())),4=>{let x=f32::from_le_bytes(row[o..o+4].try_into().unwrap());if x.is_finite(){json!(x)}else{Value::Null}},5=>{let x=f64::from_le_bytes(row[o..o+8].try_into().unwrap());if x.is_finite(){json!(x)}else{Value::Null}},_=>Value::Null}};if d.count==1{one(0)}else{Value::Array((0..d.count).map(one).collect())}}
fn values(l:&Layout,row:&[u8])->Map<String,Value>{l.desc.iter().map(|d|(d.name.clone(),read_value(d,row))).collect()}
fn num(v:&Map<String,Value>,k:&str)->f64{v.get(k).and_then(Value::as_f64).filter(|x|x.is_finite()).unwrap_or(0.)}
fn truth(v:&Map<String,Value>,k:&str)->bool{v.get(k).is_some_and(|x|x.as_bool()==Some(true)||x.as_f64().is_some_and(|n|n.is_finite()&&n!=0.))}
fn scalar(y:&str,key:&str)->Option<String>{y.lines().find_map(|l|{let (k,v)=l.trim().split_once(':')?;(k==key).then(||v.trim().trim_matches(['\"','\'']).to_owned())})}
fn identity(y: &str, session_num: i64) -> Value {
    let driver = scalar(y, "DriverCarIdx").and_then(|x| x.parse::<i64>().ok()).unwrap_or(-1);
    let track = scalar(y, "TrackDisplayName").or_else(|| scalar(y, "TrackDisplayShortName"))
        .or_else(|| scalar(y, "TrackName")).unwrap_or_else(|| "Unknown iRacing track".into());
    let track_id = scalar(y, "TrackID").and_then(|x| x.parse::<i64>().ok()).unwrap_or(-1);
    let mut car_id = -1;
    let mut car_name = "Unknown iRacing car".to_owned();
    let mut class_id = -1;
    let mut class_name = "Unknown class".to_owned();
    let mut in_drivers = false;
    let mut selected = false;
    for line in y.lines() {
        let t = line.trim();
        if t == "Drivers:" { in_drivers = true; continue; }
        if !in_drivers { continue; }
        if let Some(item) = t.strip_prefix("- ") {
            selected = false;
            if let Some((k, v)) = item.split_once(':') {
                if k == "CarIdx" { selected = v.trim().parse::<i64>().ok() == Some(driver); }
            }
            continue;
        }
        let Some((k, v)) = t.split_once(':') else { continue; };
        let val = v.trim().trim_matches(['"', '\'']);
        if selected {
            match k.trim() {
                "CarID" => car_id = val.parse().unwrap_or(-1),
                "CarScreenName" | "CarScreenNameShort" | "CarPath" if car_name == "Unknown iRacing car" => car_name = val.into(),
                "CarClassID" => class_id = val.parse().unwrap_or(-1),
                "CarClassShortName" | "CarClassRelSpeed" if class_name == "Unknown class" => class_name = val.into(),
                _ => {}
            }
        }
    }
    json!({"trackId":track_id,"trackName":track,"carId":car_id,"carName":car_name,"carClassId":class_id,"carClassName":class_name,"driverCarIdx":driver,"sessionNum":session_num})
}
fn sectors(y:&str)->Option<Vec<f64>>{let mut inside=false;let mut indent=0usize;let mut out=Vec::new();for line in y.lines(){if !inside{if line.trim()=="SplitTimeInfo:"{inside=true;indent=line.len()-line.trim_start().len()}continue}let t=line.trim();if t.is_empty()||t.starts_with('#'){continue}let n=line.len()-line.trim_start().len();if n<=indent{break}if let Some(v)=t.strip_prefix("SectorStartPct:"){if let Ok(x)=v.trim().parse::<f64>(){if x.is_finite()&&x>=0.&&x<1.{out.push(x)}}}}out.sort_by(f64::total_cmp);out.dedup();(out.len()>=2).then_some(out)}
fn preview(file:&str,l:&mut Layout,f:&mut File)->Result<Value,String>{let missing:Vec<String>=REQUIRED.iter().filter(|n|!l.by_name.contains_key(**n)).map(|x|x.to_string()).collect();let telemetry=["SessionTime","SessionTick","SessionUniqueID","SessionNum","SessionState","IsOnTrack","OnPitRoad","PlayerTrackSurface","PlayerIncidents","PlayerCarPosition","Speed","RPM","Throttle","Brake","Clutch","Gear","SteeringWheelAngle","SteeringWheelAngleMax","FuelLevel","Lap","LapCompleted","LapDist","LapDistPct","LapBestLapTime","LapLastLapTime","LapCurrentLapTime","LatAccel","LongAccel","VertAccel","VelocityX","VelocityY","VelocityZ","Yaw","Pitch","Roll","YawRate","PitchRate","RollRate","TrackTemp","AirTemp","Precipitation","TrackWetness","LFshockDefl","RFshockDefl","LRshockDefl","RRshockDefl","LFtempCL","LFtempCM","LFtempCR","RFtempCL","RFtempCM","RFtempCR","LRtempCL","LRtempCM","LRtempCR","RRtempCL","RRtempCM","RRtempCR","LFwearL","LFwearM","LFwearR","RFwearL","RFwearM","RFwearR","LRwearL","LRwearM","LRwearR","RRwearL","RRwearM","RRwearR","LFcoldPressure","RFcoldPressure","LRcoldPressure","RRcoldPressure"];let missing_race=telemetry.iter().filter(|n|!l.by_name.contains_key(**n)).map(|x|x.to_string()).collect::<Vec<_>>();let mut scans:HashMap<i64,(Option<i64>,u64,u64,bool)>=HashMap::new();let mut driving=0u64;let mut pit=0u64;let mut max_speed=0f64;let(mut first,mut last)=(None,None);let mut ident=None;let mut row=vec![0u8;l.row];for idx in 0..l.count{read_at(f,l.data+idx*l.row as u64,&mut row)?;let v=values(l,&row);let speed=num(&v,"Speed").max(0.);max_speed=max_speed.max(speed);if truth(&v,"OnPitRoad"){pit+=1}let sn=num(&v,"SessionNum").trunc() as i64;ident.get_or_insert_with(||identity(&l.yaml,sn));let on=v.get("IsOnTrack").is_some_and(|x|x.as_bool()==Some(true)||x.as_f64().is_some_and(|z|z!=0.));if !on||truth(&v,"OnPitRoad")||speed<1.{continue}driving+=1;first.get_or_insert(idx);last=Some(idx);let lap=num(&v,"Lap").max(0.).trunc() as i64;let s=scans.entry(sn).or_insert((None,0,0,true));if let Some(prev)=s.0{if lap==prev+1{s.1+=1;if s.3{s.3=false}else{s.2+=1}}else if lap!=prev{s.3=true}}s.0=Some(lap)}let transitions:u64=scans.values().map(|x|x.1).sum();let candidates:u64=scans.values().map(|x|x.2).sum();let duration=if l.count>1{(l.count-1) as f64/l.tick as f64}else{0.};let reason=if !missing.is_empty(){Some(format!("This recording is missing channels required for RaceIQ lap import: {}",missing.join(", ")))}else if driving==0{Some("No on-track driving above 2.2 mph was found in this recording".into())}else if candidates==0{Some("No complete laps were found; RaceIQ discards the partial lap at the start of an IBT recording".into())}else{None};let id=ident.unwrap_or_else(||identity(&l.yaml,0));Ok(json!({"gameId":"iracing","fileName":safe_name(file),"fileSize":l.size,"tickRate":l.tick,"recordCount":l.count,"durationSeconds":duration,"sessionStartDate":date_iso(l.date),"trackId":id["trackId"],"trackName":id["trackName"],"carId":id["carId"],"carName":id["carName"],"carClassName":id["carClassName"],"missingRaceIQVariables":missing_race,"missingRequiredVariables":missing,"drivingFrames":driving,"pitRoadFrames":pit,"lapTransitions":transitions,"candidateLapCount":candidates,"maxSpeedMph":max_speed*2.2369362921,"firstDrivingRecord":first,"lastDrivingRecord":last,"canImport":reason.is_none(),"reason":reason,"_identity":id}))}
fn field_num(y:&str,key:&str,default:f64)->f64{scalar(y,key).and_then(|x|x.parse::<f64>().ok()).filter(|x|x.is_finite()).unwrap_or(default)}
fn session_snapshot(y:&str,sn:i64)->Value{let id=identity(y,sn);let len=scalar(y,"TrackLength").and_then(|x|{let v=x.trim();let start=v.find(|c:char|c.is_ascii_digit()||c=='-'||c=='.')?;let number=v[start..].split_whitespace().next()?.parse::<f64>().ok()?;let unit=v[start..].split_whitespace().nth(1).unwrap_or("m").to_ascii_lowercase();Some(match unit.as_str(){"km"=>number*1000.,"mi"=>number*1609.344,"ft"=>number*0.3048,_=>number})}).unwrap_or(0.);json!({"sessionId":scalar(y,"SessionID").and_then(|x|x.parse::<f64>().ok()).unwrap_or(0.),"subSessionId":scalar(y,"SubSessionID").and_then(|x|x.parse::<f64>().ok()).unwrap_or(0.),"sessionNum":sn,"driverCarIdx":id["driverCarIdx"],"trackId":id["trackId"],"trackName":id["trackName"],"trackLengthM":len,"sectorStarts":sectors(y),"carId":id["carId"],"carName":id["carName"],"carClassId":id["carClassId"],"carClassName":id["carClassName"],"engineIdleRpm":field_num(y,"DriverCarIdleRPM",0.),"engineRedlineRpm":field_num(y,"DriverCarRedLine",0.),"engineCylinderCount":field_num(y,"DriverCarEngCylinderCount",0.)})}
struct Encoder{session:Option<Value>,previous:Map<String,Value>}
impl Encoder{fn new()->Self{Self{session:None,previous:Map::new()}}fn encode(&mut self,frame:&Value)->Result<Vec<u8>,String>{let session=frame.get("session").cloned().ok_or("Missing IBT session snapshot")?;let vals=frame.get("values").and_then(Value::as_object).ok_or("Missing IBT values")?;let mut full=json!({"schemaVersion":3,"session":session,"values":vals,"sessionInfo":frame["sessionInfo"],"sessionInfoUpdate":0});let bytes=if self.session.as_ref()!=full.get("session"){crate::games::iracing::encode_session(&full)?}else{let mut delta=full.clone();delta.as_object_mut().unwrap().insert("previousValues".into(),Value::Object(self.previous.clone()));crate::games::iracing::encode_delta(&delta)?};self.session=full.get("session").cloned();self.previous=vals.clone();Ok(bytes)}}
fn safe_name(s:&str)->String{let leaf=s.rsplit(['/','\\']).next().unwrap_or(s);if leaf.to_ascii_lowercase().ends_with(".ibt"){leaf.into()}else{"session.ibt".into()}}
fn date_iso(s:i64)->String{let days=s.div_euclid(86400);let secs=s.rem_euclid(86400);let z=days+719468;let era=if z>=0{z}else{z-146096}.div_euclid(146097);let doe=z-era*146097;let yoe=(doe-doe/1460+doe/36524-doe/146096)/365;let mut y=yoe+era*400;let doy=doe-(365*yoe+yoe/4-yoe/100);let mp=(5*doy+2)/153;let d=doy-(153*mp+2)/5+1;let m=mp+if mp<10{3}else{-9};if m<=2{y+=1}format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",secs/3600,(secs%3600)/60,secs%60)}
pub(super) fn run(operation:&str,input:Value,config:&Value)->Result<Value,String>{
    let (job,out)=super::paths::job_dir(&input,config)?;
    let path=super::paths::staged_input(&input,config)?;
    let original=input.pointer("/input/originalName").and_then(Value::as_str)
        .or_else(||path.file_name().and_then(|x|x.to_str())).unwrap_or("session.ibt");
    let (mut f,mut l)=layout(&path)?;
    let mut p=preview(original,&mut l,&mut f)?;
    if operation=="preview"{
        p.as_object_mut().unwrap().remove("_identity");
        let packet_count=if p["canImport"]==true{
            let first=p["firstDrivingRecord"].as_u64().unwrap_or(0);
            let last=p["lastDrivingRecord"].as_u64().unwrap_or(0);
            let tail=(l.tick as u64).saturating_mul(5);
            last.saturating_add(tail).min(l.count.saturating_sub(1)).saturating_sub(first).saturating_add(1)
        }else{0};
        let manifest=json!({"version":1,"jobId":job,"operation":"preview","kind":"ibt-preview","packetCount":packet_count,"sessions":[],"preview":p,"artifacts":[]});
        let dest=out.join("result.json");
        std::fs::write(&dest,serde_json::to_vec(&manifest).map_err(|e|e.to_string())?).map_err(|e|format!("Write IBT preview: {e}"))?;
        return Ok(super::response(&job,&dest))
    }
    if operation!="import"{return Err(format!("Unsupported IBT operation: {operation}"))}
    if !p["canImport"].as_bool().unwrap_or(false){return Err(p["reason"].as_str().unwrap_or("IBT cannot be imported").to_owned())}
    if input.pointer("/options/gameId").and_then(Value::as_str).is_some_and(|g|g!="iracing"){return Err("IBT import target must be iRacing".into())}
    let first=p["firstDrivingRecord"].as_u64().ok_or("IBT driving range missing first frame")?;
    let last=p["lastDrivingRecord"].as_u64().ok_or("IBT driving range missing last frame")?;
    let tail=(l.tick as u64).checked_mul(5).ok_or("IBT timing tail overflow")?;
    let end=last.saturating_add(tail).min(l.count.saturating_sub(1));
    let source_identity=p.as_object_mut().unwrap().remove("_identity").unwrap_or_else(||identity(&l.yaml,0));
    let mut options=input.get("options").cloned().unwrap_or_else(||json!({}));
    options.as_object_mut().ok_or("Invalid IBT import options")?.insert("gameId".into(),json!("iracing"));
    let mut encoder=Encoder::new();
    let mut row=vec![0u8;l.row];
    let mut index=first;
    let mut session_cache:Option<(i64,Value)>=None;
    let records=std::iter::from_fn(move||{
        if index>end{return None}
        let current=index;index+=1;
        let result=(||{
            read_at(&mut f,l.data+current*l.row as u64,&mut row)?;
            let vals=values(&l,&row);
            let sn=num(&vals,"SessionNum").trunc() as i64;
            if session_cache.as_ref().is_none_or(|(key,_)|*key!=sn){session_cache=Some((sn,session_snapshot(&l.yaml,sn)))}
            let session=session_cache.as_ref().unwrap().1.clone();
            let frame=json!({"schemaVersion":3,"session":session,"values":vals,"sessionInfo":l.yaml,"sessionInfoUpdate":0});
            let payload=encoder.encode(&frame)?;
            let time=(current as f64*1000./l.tick as f64).round() as u64;
            Ok(crate::formats::SourceRecord{offset:current,time_ms:Some(time),kind:crate::formats::RecordKind::Frame,payload})
        })();
        Some(result)
    });
    let mut capture=super::capture::process_record_results("import",records,original,&options,&out,config)?;
    let packet_count=capture["packetCount"].as_u64().unwrap_or(0);
    let mut sessions=match capture.get_mut("sessions").map(Value::take){Some(Value::Array(value))=>value,_=>Vec::new()};
    for session in &mut sessions{if let Some(m)=session.as_object_mut(){
        m.insert("carOrdinal".into(),source_identity.get("carId").cloned().unwrap_or(json!(-1)));
        m.insert("trackOrdinal".into(),source_identity.get("trackId").cloned().unwrap_or(json!(-1)));
    }}
    let artifacts=capture["artifacts"].as_array().into_iter().flatten().filter_map(|a|a.get("path").cloned()).collect::<Vec<_>>();
    p.as_object_mut().unwrap().remove("_identity");
    let mut manifest=json!({"version":1,"jobId":job,"operation":"import","kind":"capture","gameId":"iracing","packetCount":packet_count});
    let fields=manifest.as_object_mut().unwrap();
    fields.insert("sessions".into(),Value::Array(sessions));
    fields.insert("preview".into(),p);
    fields.insert("artifacts".into(),Value::Array(artifacts));
    fields.insert("sourceIdentity".into(),source_identity);
    fields.insert("events".into(),capture["events"].take());
    fields.insert("completion".into(),capture["completion"].take());
    let dest=out.join("result.json");
    std::fs::write(&dest,serde_json::to_vec(&manifest).map_err(|e|e.to_string())?).map_err(|e|format!("Write IBT result: {e}"))?;
    Ok(super::response(&job,&dest))
}
