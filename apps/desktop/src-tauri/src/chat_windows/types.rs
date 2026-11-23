use super::*;
use serde::Deserialize;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Geometry {
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) titlebar: String,
    pub(super) title: String,
}
impl Geometry {
    pub(super) fn validate(&self) -> Result<(), &'static str> {
        if !(360..=1600).contains(&self.width)
            || !(480..=1200).contains(&self.height)
            || !["native", "integrated"].contains(&self.titlebar.as_str())
        {
            return Err("invalid-chat-geometry");
        }
        identifier(&self.title, 200)
    }
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Command {
    Context {
        nonce: String,
    },
    #[serde(rename_all = "camelCase")]
    Reserve {
        incarnation: String,
        scope: Scope,
        view_id: String,
        creation_agent_id: Option<String>,
        new_transition: bool,
    },
    #[serde(rename_all = "camelCase")]
    Phase {
        incarnation: String,
        scope: Scope,
        transition_id: String,
        phase: Phase,
    },
    #[serde(rename_all = "camelCase")]
    RecoverInline {
        incarnation: String,
        scope: Scope,
        expected_transition_id: String,
    },
    Lookup {
        incarnation: String,
        scope: Scope,
    },
    Launch {
        incarnation: String,
        scope: Scope,
        geometry: Geometry,
    },
    #[serde(rename_all = "camelCase")]
    Ready {
        incarnation: String,
        binding: Binding,
        visible: bool,
    },
    CreationRefused {
        incarnation: String,
    },
    #[serde(rename_all = "camelCase")]
    BindUi {
        incarnation: String,
        host_id: String,
        profile_id: String,
    },
    PublishUi {
        incarnation: String,
        snapshot: Value,
        children: Vec<ChildSnapshot>,
    },
    ReadUi {
        incarnation: String,
    },
    Presence {
        incarnation: String,
        visible: bool,
        display: Option<Value>,
    },
    ReportUi {
        incarnation: String,
        report: Value,
    },
    DrainUi {
        incarnation: String,
    },
    ConfirmUi {
        incarnation: String,
        ids: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    IntentContext {
        incarnation: String,
        #[serde(default)]
        retire_after: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    PlacementIntent {
        incarnation: String,
        request_id: String,
        action: Action,
    },
    #[serde(rename_all = "camelCase")]
    ReadIntent {
        incarnation: String,
        request_id: String,
    },
    PendingIntents {
        incarnation: String,
    },
    #[serde(rename_all = "camelCase")]
    CarryApplied {
        incarnation: String,
        source_scope: Scope,
        request_id: String,
    },
    OwnIntents {
        incarnation: String,
        #[serde(default)]
        after: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    RetryIntent {
        incarnation: String,
        request_id: String,
    },
    Reservations {
        incarnation: String,
    },
    #[serde(rename_all = "camelCase")]
    AssignIntent {
        incarnation: String,
        source_scope: Scope,
        request_id: String,
        scope: Scope,
        view_id: String,
        creation_agent_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    CompleteIntent {
        incarnation: String,
        source_scope: Scope,
        request_id: String,
        result: Value,
    },
    RestoreBuiltin {
        incarnation: String,
    },
    ReadRecovery {
        incarnation: String,
    },
    ConfirmRecovery {
        incarnation: String,
        sequence: u64,
    },
    CloseCancelled {
        incarnation: String,
    },
    CloseReady {
        incarnation: String,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChildSnapshot {
    pub(super) incarnation: String,
    pub(super) envelope: Value,
    pub(super) display: Option<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub(super) schema_version: u8,
    pub(super) kind: String,
    pub(super) scope: Scope,
    pub(super) view_id: String,
    pub(super) revision: u64,
    pub(super) writer_generation: u64,
}
