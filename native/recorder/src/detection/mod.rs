pub mod iracing;
pub mod kunos;
pub mod ordinal;
pub mod policy;

use serde_json::Value;

/// Source-specific state machines share only their lifecycle interface.
pub enum Detector {
    Ordinal(ordinal::OrdinalDetector),
    Kunos(kunos::KunosDetector),
    IRacing(iracing::IRacingDetector),
}

impl Detector {
    pub fn new(game_id: &str) -> Result<Self, String> {
        match game_id {
            "acc" | "ac-evo" => kunos::KunosDetector::new(game_id).map(Self::Kunos),
            "iracing" => iracing::IRacingDetector::new().map(Self::IRacing),
            "fm-2023" | "f1-2025" | "lmu" => ordinal::OrdinalDetector::new(game_id).map(Self::Ordinal),
            _ => Err(format!("unsupported detector game: {game_id}")),
        }
    }

    pub fn feed(&mut self, packet: Value, offset: u64) -> Result<Vec<Value>, String> {
        match self {
            Self::Ordinal(detector) => Ok(detector.feed(packet, offset)),
            Self::Kunos(detector) => detector.feed(packet, offset),
            Self::IRacing(detector) => Ok(detector.feed(packet, offset)),
        }
    }

    pub fn feed_at(&mut self, packet: Value, offset: u64, host_time_ms: u64) -> Result<Vec<Value>, String> {
        match self {
            Self::Ordinal(detector) => Ok(detector.feed_at(packet, offset, host_time_ms)),
            Self::Kunos(detector) => detector.feed_at(packet, offset, host_time_ms),
            Self::IRacing(detector) => Ok(detector.feed_at(packet, offset, host_time_ms)),
        }
    }

    pub fn tick(&mut self, host_time_ms: u64) -> Result<Vec<Value>, String> {
        Ok(match self {
            Self::Ordinal(detector) => detector.tick(host_time_ms),
            Self::Kunos(detector) => detector.tick(host_time_ms),
            Self::IRacing(detector) => detector.tick(host_time_ms),
        })
    }

    pub fn snapshot_incomplete_lap(&mut self) -> Result<Vec<Value>, String> {
        match self {
            Self::Ordinal(detector) => Ok(detector.snapshot_incomplete_lap()),
            _ => Err("provisional race-off snapshots require the Forza ordinal detector".into()),
        }
    }

    pub fn finish(&mut self, reason: &str) -> Result<Vec<Value>, String> {
        Ok(match self {
            Self::Ordinal(detector) => detector.finish(reason),
            Self::Kunos(detector) => detector.finish(reason),
            Self::IRacing(detector) => detector.finish(reason),
        })
    }

    pub fn reset(&mut self) {
        match self {
            Self::Ordinal(detector) => detector.reset(),
            Self::Kunos(detector) => detector.reset(),
            Self::IRacing(detector) => detector.reset(),
        }
    }
}
