use serde_json::Value;

const CATALOGS: &str = include_str!("generated/catalogs.json");
static CATALOG_DATA:std::sync::LazyLock<Value>=std::sync::LazyLock::new(||serde_json::from_str(CATALOGS).expect("generated game catalogs"));
const LAYOUTS: &str = include_str!("generated/layouts.json");
static LAYOUT_DATA:std::sync::LazyLock<Value>=std::sync::LazyLock::new(||serde_json::from_str(LAYOUTS).expect("generated game layouts"));

pub fn layout(game: &str) -> Option<&'static Value> { LAYOUT_DATA.get(game) }
pub fn layout_number(game:&str,group:&str,key:&str)->Option<usize>{
    LAYOUT_DATA.get(game)?.get(group)?.get(key)?.as_u64().map(|value|value as usize)
}
pub fn layout_constant(game:&str,key:&str)->Option<usize>{
    LAYOUT_DATA.get(game)?.get(key)?.as_u64().map(|value|value as usize)
}
pub fn game(game_id: &str) -> Option<&'static Value> {
    let key = match game_id { "fm-2023"=>"fm", "f1-2025"=>"f1", "acc"=>"acc", "ac-evo"=>"evo", "iracing"=>"iracing", "lmu"=>"lmu", _=>return None };
    CATALOG_DATA.get(key)
}
fn lmu_model_alias(name:&str)->String{
    let name=name.trim();
    if let Some((base,year))=name.rsplit_once(char::is_whitespace){
        if year.len()==4&&year.bytes().all(|b|b.is_ascii_digit()){return base.to_owned();}
    }
    name.to_owned()
}


/// Resolve catalog entry by exact stable ordinal/ID or case-insensitive display
/// name. Source-specific resolvers should apply their aliases before this lookup.
pub fn resolve(game_id: &str, section: &str, key: &str, value: &str) -> Option<Value> {
    let catalog = game(game_id)?;
    let entries = catalog.get(section)?.as_array()?;
    entries.iter().find(|entry| {
        let obj=entry.as_object().unwrap();
        obj.get(key).and_then(Value::as_str).map(|v|v==value).unwrap_or(false)
            || obj.get(key).and_then(Value::as_i64).map(|v|v.to_string()==value).unwrap_or(false)
            || obj.get("name").and_then(Value::as_str).map(|v|v.eq_ignore_ascii_case(value)).unwrap_or(false)
            || obj.get("model").and_then(Value::as_str).map(|v|v.eq_ignore_ascii_case(value)).unwrap_or(false)
    }).cloned()
}

fn normalized(value: &str) -> String { value.trim().to_lowercase() }

type EntryIndex<'a> = std::collections::HashMap<String, Vec<&'a Value>>;

struct LmuIndexes<'a> {
    cars: [EntryIndex<'a>; 3],
    tracks: [EntryIndex<'a>; 2],
}

fn add<'a>(index: &mut EntryIndex<'a>, alias: &str, entry: &'a Value) {
    let entries = index.entry(normalized(alias)).or_default();
    // Each source entry occurs once per alias, even when ID, suffix and layout agree.
    if !entries.iter().any(|candidate| std::ptr::eq(*candidate, entry)) {
        entries.push(entry);
    }
}

fn lmu_indexes<'a>(cars: &'a [Value], tracks: &'a [Value]) -> LmuIndexes<'a> {
    let mut indexes = LmuIndexes {
        cars: std::array::from_fn(|_| EntryIndex::new()),
        tracks: std::array::from_fn(|_| EntryIndex::new()),
    };
    for entry in cars {
        if let Some(id) = entry.get("id").and_then(Value::as_str) { add(&mut indexes.cars[0], id, entry); }
        if let Some(variants) = entry.get("variants").and_then(Value::as_array) {
            for variant in variants { if let Some(id) = variant.get("id").and_then(Value::as_str) { add(&mut indexes.cars[0], id, entry); } }
        }
        if let Some(names) = entry.get("vehicleNames").and_then(Value::as_array) {
            for name in names.iter().filter_map(Value::as_str) { add(&mut indexes.cars[1], name, entry); }
        }
        if let Some(variants) = entry.get("variants").and_then(Value::as_array) {
            for variant in variants { if let Some(name) = variant.get("name").and_then(Value::as_str) { add(&mut indexes.cars[1], name, entry); } }
        }
        if let Some(name) = entry.get("name").and_then(Value::as_str) {
            add(&mut indexes.cars[2], name, entry);
            let alias = lmu_model_alias(name);
            add(&mut indexes.cars[2], &alias, entry);
        }
    }
    for entry in tracks {
        if let Some(id) = entry.get("id").and_then(Value::as_str) {
            add(&mut indexes.tracks[0], id, entry);
            if let Some(last) = id.rsplit('/').next() { add(&mut indexes.tracks[0], last, entry); }
        }
        if let Some(layout) = entry.get("layout").and_then(Value::as_str) { add(&mut indexes.tracks[0], layout, entry); }
        if let Some(name) = entry.get("name").and_then(Value::as_str) { add(&mut indexes.tracks[1], name, entry); }
    }
    indexes
}

static LMU_INDEXES: std::sync::LazyLock<LmuIndexes<'static>> = std::sync::LazyLock::new(|| {
    let catalog = game("lmu").expect("LMU catalog");
    lmu_indexes(
        catalog["cars"].as_array().expect("LMU cars"),
        catalog["tracks"].as_array().expect("LMU tracks"),
    )
});

fn lmu_car<'a>(indexes: &LmuIndexes<'a>, car_id: &str, vehicle_name: &str) -> Option<&'a Value> {
    let needles = [normalized(car_id), normalized(vehicle_name)];
    for index in &indexes.cars {
        let mut candidate: Option<&Value> = None;
        for needle in needles.iter().filter(|needle| !needle.is_empty()) {
            if let Some(entries) = index.get(needle) {
                for entry in entries {
                    // The original car resolver deduplicates by value, not source position.
                    if let Some(previous) = candidate {
                        if previous != *entry { return None; }
                    } else {
                        candidate = Some(*entry);
                    }
                }
            }
        }
        if candidate.is_some() { return candidate; }
    }
    None
}

/// Resolve exact IDs, vehicle aliases, then year-stripped catalog model names.
/// Ambiguity in an earlier tier never falls through to a later tier.
pub fn resolve_lmu_car(car_id: &str, vehicle_name: &str) -> Option<&'static Value> {
    lmu_car(&LMU_INDEXES, car_id, vehicle_name)
}

fn lmu_track<'a>(indexes: &LmuIndexes<'a>, track_ids: &[&str]) -> Option<&'a Value> {
    let needles: Vec<_> = track_ids.iter().map(|input| normalized(input))
        .filter(|input| !input.is_empty()).collect();
    for index in &indexes.tracks {
        let mut sets = needles.iter().filter_map(|needle| index.get(needle));
        let Some(first_set) = sets.next() else { continue; };
        let mut common = first_set.iter().copied().filter(|entry| {
            needles.iter().filter_map(|needle| index.get(needle))
                .all(|set| set.contains(entry))
        });
        let first = common.next()?;
        return if common.next().is_none() { Some(first) } else { None };
    }
    None
}

/// Resolve ID/suffix/layout intersections first, then display-name intersections.
/// Unknown inputs are ignored; a matched but empty or ambiguous intersection stops.
pub fn resolve_lmu_track(track_ids: &[&str]) -> Option<&'static Value> {
    lmu_track(&LMU_INDEXES, track_ids)
}

fn kunos_name(value:&str)->String{value.to_lowercase().chars().filter(|c|!matches!(c,'-'|'_'|' ')&&!c.is_whitespace()).collect()}

pub fn resolve_acc_car_id(model:&str)->Option<i64>{
    let entries=game("acc")?.get("cars")?.as_array()?;
    entries.iter().find(|entry| {
        let obj=entry.as_object().unwrap();
        obj.get("model").and_then(Value::as_str).map(|v|v==model).unwrap_or(false)
            || obj.get("model").and_then(Value::as_i64).map(|v|v.to_string()==model).unwrap_or(false)
            || obj.get("name").and_then(Value::as_str).map(|v|v.eq_ignore_ascii_case(model)).unwrap_or(false)
            || obj.get("model").and_then(Value::as_str).map(|v|v.eq_ignore_ascii_case(model)).unwrap_or(false)
    })?.get("id")?.as_i64()
}

pub fn resolve_acc_track_id(name:&str)->Option<i64>{
    let entries=game("acc")?.get("tracks")?.as_array()?;let needle=kunos_name(name);
    entries.iter().find(|entry|entry.get("name").and_then(Value::as_str).map(|v|{let candidate=kunos_name(v);candidate==needle||candidate.contains(&needle)||needle.contains(&candidate)}).unwrap_or(false))?.get("id")?.as_i64()
}



pub fn resolve_evo_car(display_name:&str)->Option<Value>{
    let entries=game("ac-evo")?.get("cars")?.as_array()?;let needle=display_name.to_lowercase().trim().to_owned();
    entries.iter().find(|entry|entry.get("name").and_then(Value::as_str).map(|s|s.to_lowercase()==needle).unwrap_or(false)).cloned().or_else(||{
        let compact=|s:&str|s.to_lowercase().chars().filter(|c|!matches!(c,'-'|'_')&&!c.is_whitespace()).collect::<String>();let target=compact(display_name);if target.is_empty(){return None;}
        entries.iter().find(|entry|["name","model"].iter().any(|k|entry.get(*k).and_then(Value::as_str).map(|s|compact(s)==target).unwrap_or(false))).cloned()
    })
}

pub fn resolve_evo_track(name:&str,config:&str)->Option<Value>{
    let entries=game("ac-evo")?.get("tracks")?.as_array()?;let needle=kunos_name(name);if needle.is_empty(){return None;}
    let find_exact=|needle:&str|entries.iter().find(|entry|{
        ["commonTrackName","name"].iter().any(|k|entry.get(*k).and_then(Value::as_str).map(|s|kunos_name(s)==needle).unwrap_or(false))
            || {let n=entry.get("name").and_then(Value::as_str).unwrap_or("");let variant=entry.get("variant").and_then(Value::as_str).unwrap_or("");kunos_name(&format!("{n}{variant}"))==needle}
    }).cloned();
    if !config.is_empty(){let combined=kunos_name(&format!("{name}{config}"));if combined!=needle {if let Some(v)=find_exact(&combined){return Some(v);}}}
    if let Some(v)=find_exact(&needle){return Some(v);}
    let mut best=None;let mut best_len=0;
    for entry in entries {for key in ["commonTrackName","name"] {if let Some(value)=entry.get(key).and_then(Value::as_str){let candidate=kunos_name(value);if !candidate.is_empty()&&(candidate.contains(&needle)||needle.contains(&candidate)){let len=candidate.len().min(needle.len());if len>best_len {best=Some(entry.clone());best_len=len;}}}}}
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lmu_car_tiers_stop_on_ambiguity_and_preserve_alias_precedence() {
        let cars = vec![
            json!({"id":"alpha","name":"Roadster 2024",
                "vehicleNames":["shared","beta","Roadster 2025"],
                "variants":[{"id":"variant-a","name":"Variant A"},{"id":"variant-a","name":"Variant A"}]}),
            json!({"id":"beta","name":"Roadster 2025","vehicleNames":["shared"],
                "variants":[{"id":"ambiguous-id","name":"Ambiguous Alias"}]}),
            json!({"id":"ambiguous-id","name":"Third 2024","vehicleNames":["Ambiguous Alias"]}),
        ];
        let indexes = lmu_indexes(&cars, &[]);
        assert_eq!(lmu_car(&indexes, " BETA ", "shared"), Some(&cars[1]));
        assert_eq!(lmu_car(&indexes, "alpha", "shared"), Some(&cars[0]));
        assert_eq!(lmu_car(&indexes, "unknown", "Roadster 2025"), Some(&cars[0]));
        assert_eq!(lmu_car(&indexes, "variant-a", "Variant A"), Some(&cars[0]));
        assert_eq!(lmu_car(&indexes, "unknown", "Variant A"), Some(&cars[0]));
        assert_eq!(lmu_car(&indexes, "alpha", "beta"), None);
        assert_eq!(lmu_car(&indexes, "ambiguous-id", "Variant A"), None);
        assert_eq!(lmu_car(&indexes, "shared", "Roadster 2024"), None);
        assert_eq!(lmu_car(&indexes, "Ambiguous Alias", "Roadster 2024"), None);
        assert_eq!(lmu_car(&indexes, " ", " "), None);
    }

    #[test]
    fn lmu_model_year_aliases_strip_only_catalog_four_digit_suffixes() {
        let cars = vec![
            json!({"id":"first","name":"Roadster 2024"}),
            json!({"id":"second","name":"Roadster 2025"}),
            json!({"id":"third","name":"Solo\t2026"}),
            json!({"id":"short-year","name":"Short 123"}),
            json!({"id":"non-year","name":"Other 202A"}),
        ];
        let indexes = lmu_indexes(&cars, &[]);
        assert_eq!(lmu_car(&indexes, "Roadster", ""), None);
        assert_eq!(lmu_car(&indexes, " roadster 2024 ", ""), Some(&cars[0]));
        assert_eq!(lmu_car(&indexes, "Roadster 2030", ""), None);
        assert_eq!(lmu_car(&indexes, "solo", ""), Some(&cars[2]));
        assert_eq!(lmu_car(&indexes, "Short", ""), None);
        assert_eq!(lmu_car(&indexes, "Short 123", ""), Some(&cars[3]));
        assert_eq!(lmu_car(&indexes, "Other", ""), None);
        assert_eq!(lmu_car(&indexes, "Other 202a", ""), Some(&cars[4]));
    }

    #[test]
    fn lmu_track_intersections_ignore_unknowns_but_not_conflicts() {
        let tracks = vec![
            json!({"id":"venue/main","layout":"main","name":"Circuit"}),
            json!({"id":"venue/short","layout":"main","name":"Circuit"}),
            json!({"id":"solo","layout":"solo","name":"Independent"}),
        ];
        let indexes = lmu_indexes(&[], &tracks);
        assert_eq!(lmu_track(&indexes, &["main"]), None);
        assert_eq!(lmu_track(&indexes, &["main", " VENUE/MAIN "]), Some(&tracks[0]));
        assert_eq!(lmu_track(&indexes, &["main", "venue/short"]), Some(&tracks[1]));
        assert_eq!(lmu_track(&indexes, &["venue/main", "venue/short"]), None);
        assert_eq!(lmu_track(&indexes, &["main", "unknown"]), None);
        assert_eq!(lmu_track(&indexes, &["main", "Independent"]), None);
        assert_eq!(lmu_track(&indexes, &["solo", "unknown", "solo"]), Some(&tracks[2]));
        assert_eq!(lmu_track(&indexes, &["Circuit"]), None);
        assert_eq!(lmu_track(&indexes, &["Circuit", "Independent"]), None);
        assert_eq!(lmu_track(&indexes, &["unknown", "Independent"]), Some(&tracks[2]));
        assert_eq!(lmu_track(&indexes, &["venue/main", "Independent"]), Some(&tracks[0]));
        assert_eq!(lmu_track(&indexes, &[" ", "unknown"]), None);
    }

    #[test]
    fn lmu_indexes_preserve_source_entry_deduplication_rules() {
        let entry = json!({"id":"same","layout":"same","name":"Same 2024"});
        let entries = vec![entry.clone(), entry];
        let indexes = lmu_indexes(&entries, &entries);
        // Car unions deduplicate equal values; track intersections retain source rows.
        assert_eq!(lmu_car(&indexes, "same", ""), Some(&entries[0]));
        assert_eq!(lmu_track(&indexes, &["same"]), None);
        let unique = lmu_indexes(&entries[..1], &entries[..1]);
        assert_eq!(lmu_track(&unique, &["same"]), Some(&entries[0]));
    }

    #[test]
    fn generated_lmu_tracks_resolve_unique_ids_despite_duplicate_aliases() {
        let tracks = game("lmu").unwrap()["tracks"].as_array().unwrap();
        for entry in tracks {
            let id = entry["id"].as_str().unwrap();
            if tracks.iter().filter(|candidate| candidate["id"] == entry["id"]).count() == 1 {
                assert_eq!(resolve_lmu_track(&[id]), Some(entry), "{id}");
                assert_eq!(resolve_lmu_track(&[id, id]), Some(entry), "{id}");
            }
        }
    }
}
