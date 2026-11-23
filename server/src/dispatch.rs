//! The dispatcher — the role that decides *who* takes a work order.
//!
//! Until now the pipeline was hard-coded: a new order always started at
//! `intake` with `w1`, and every hand-off used the next station's primary
//! worker. That made "who assigns the work" invisible on the shop floor.
//!
//! Here the decision is a pure rule pass over the live projection. It returns
//! a scored pick plus the reasoning, and the runtime writes that reasoning to
//! the append-only log as `dispatch.decision`. Same snapshot in, same decision
//! out — replay reproduces the assignment, it doesn't re-invent one.

use crate::protocol::Worker;

/// Only the designated floater may change stations. Without this, a free
/// specialist beats a busy regular and the whole floor starts drifting.
const FLOATER: &str = "w4";

pub struct Candidate {
    pub worker_id: String,
    pub worker_name: String,
    pub score: f64,
    pub note: String,
}

pub struct Decision {
    pub stage_id: String,
    pub worker_id: String,
    pub worker_name: String,
    pub score: f64,
    pub reason: String,
    /// The runners-up, already formatted for the log/UI.
    pub alternatives: String,
    /// `Some(from)` when the pick is stationed elsewhere and must move first.
    pub reassign_from: Option<String>,
}

fn station_note(worker: &Worker, stage: &str) -> (&'static str, f64) {
    if worker.stage_id == stage {
        ("常驻本工位", 0.35)
    } else if worker.stage_id.is_empty() || worker.stage_id == "float" {
        ("机动待命", 0.16)
    } else {
        ("跨工位补位", 0.04)
    }
}

fn status_note(status: &str) -> (&'static str, f64) {
    match status {
        "idle" => ("空闲", 0.12),
        "busy" => ("在忙", -0.18),
        "blocked" => ("阻塞", -0.55),
        "paused" => ("暂停", -0.30),
        _ => ("未知", 0.0),
    }
}

/// Score every worker for one station. Ties keep the earlier worker in the
/// roster, so the decision is stable across replays and processes.
pub fn decide(stage_id: &str, workers: &[Worker]) -> Option<Decision> {
    let mut scored: Vec<Candidate> = workers
        .iter()
        .map(|w| {
            let (station, station_score) = station_note(w, stage_id);
            let (status, status_score) = status_note(&w.status);
            let mut score = 0.40 + station_score + status_score - w.load.clamp(0.0, 1.0) * 0.15;
            if w.stage_id != stage_id && w.id != FLOATER {
                // Specialists stay at their station; only the floater is mobile.
                score -= 0.45;
            }
            Candidate {
                worker_id: w.id.clone(),
                worker_name: w.name.clone(),
                score: (score * 100.0).round() / 100.0,
                note: format!("{station}·{status}"),
            }
        })
        .collect();
    if scored.is_empty() {
        return None;
    }

    let mut best = 0usize;
    for i in 1..scored.len() {
        if scored[i].score > scored[best].score {
            best = i;
        }
    }
    let pick = scored.remove(best);
    let worker = workers.iter().find(|w| w.id == pick.worker_id)?;
    let (station, _) = station_note(worker, stage_id);
    let (status, _) = status_note(&worker.status);
    let alternatives = scored
        .iter()
        .map(|c| format!("{} {:.2}（{}）", c.worker_name, c.score, c.note))
        .collect::<Vec<_>>()
        .join(" / ");
    let reason = format!(
        "{}，{}，负载 {:.2}，得分 {:.2}",
        station, status, worker.load, pick.score
    );
    Some(Decision {
        stage_id: stage_id.into(),
        worker_id: pick.worker_id.clone(),
        worker_name: pick.worker_name.clone(),
        score: pick.score,
        reason,
        alternatives,
        reassign_from: if worker.stage_id == stage_id {
            None
        } else {
            Some(worker.stage_id.clone())
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn worker(id: &str, stage: &str, status: &str, load: f64) -> Worker {
        Worker {
            id: id.into(),
            name: id.into(),
            model: String::new(),
            stage_id: stage.into(),
            status: status.into(),
            load,
            tokens: 0,
            task_id: None,
            config_id: None,
        }
    }

    #[test]
    fn prefers_the_station_regular_when_idle() {
        let workers = vec![
            worker("w1", "intake", "idle", 0.0),
            worker("w4", "review", "idle", 0.0),
        ];
        let d = decide("intake", &workers).expect("decision");
        assert_eq!(d.worker_id, "w1");
        assert!(d.reassign_from.is_none());
    }

    #[test]
    fn falls_back_to_the_float_worker_when_the_regular_is_blocked() {
        let workers = vec![
            worker("w1", "intake", "blocked", 0.8),
            worker("w4", "review", "idle", 0.0),
        ];
        let d = decide("intake", &workers).expect("decision");
        assert_eq!(d.worker_id, "w4");
        assert_eq!(d.reassign_from.as_deref(), Some("review"));
    }

    #[test]
    fn keeps_specialists_at_their_station() {
        let workers = vec![
            worker("w1", "intake", "busy", 0.8),
            worker("w2", "analysis", "idle", 0.0),
        ];
        let d = decide("intake", &workers).expect("decision");
        assert_eq!(d.worker_id, "w1");
    }

    #[test]
    fn decision_is_deterministic_for_equal_scores() {
        let workers = vec![
            worker("w1", "analysis", "idle", 0.0),
            worker("w4", "analysis", "idle", 0.0),
        ];
        let a = decide("analysis", &workers).expect("decision");
        let b = decide("analysis", &workers).expect("decision");
        assert_eq!(a.worker_id, b.worker_id);
        assert_eq!(a.score, b.score);
    }
}
