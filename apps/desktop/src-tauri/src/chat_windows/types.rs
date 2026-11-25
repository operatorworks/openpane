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
#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiRecoveryContext {
    pub host_id: String,
    pub profile_id: String,
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
        intent_ref: Option<IntentRef>,
    },
    #[serde(rename_all = "camelCase")]
    CancelReservation {
        incarnation: String,
        scope: Scope,
        transition_id: String,
        #[serde(default)]
        previous: Option<Reservation>,
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
        expected_context: UiRecoveryContext,
    },
    Lookup {
        incarnation: String,
        scope: Scope,
    },
    Launch {
        incarnation: String,
        scope: Scope,
        geometry: Geometry,
        #[serde(default, rename = "existingOnly")]
        existing_only: bool,
        #[serde(default, rename = "intentRef")]
        intent_ref: Option<IntentRef>,
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
        source_scope: Option<Scope>,
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
        view_id: Option<String>,
        creation_agent_id: Option<String>,
        current_binding: Option<Binding>,
    },
    #[serde(rename_all = "camelCase")]
    CompleteIntent {
        incarnation: String,
        source_scope: Scope,
        request_id: String,
        result: Value,
    },
    #[serde(rename_all = "camelCase")]
    RestoreBuiltin {
        incarnation: String,
        request_id: Option<String>,
        expected_context: Option<UiRecoveryContext>,
    },
    ReadRecovery {
        incarnation: String,
    },
    ReadRecoveryCancellation {
        incarnation: String,
        sequence: u64,
    },
    #[serde(rename_all = "camelCase")]
    ScopeRecovery {
        incarnation: String,
        sequence: u64,
        expected_context: UiRecoveryContext,
        submitted: bool,
    },
    #[serde(rename_all = "camelCase")]
    ConfirmRecovery {
        incarnation: String,
        sequence: u64,
        delivery_generation: u64,
        expected_context: UiRecoveryContext,
    },
    #[serde(rename_all = "camelCase")]
    CloseCancelled {
        incarnation: String,
        attempt_id: String,
    },
    ReadClose {
        incarnation: String,
    },
    #[serde(rename_all = "camelCase")]
    CloseReady {
        incarnation: String,
        attempt_id: String,
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

impl Binding {
    pub(super) fn admits(&self, scope: &Scope, view_id: &str) -> bool {
        self.schema_version == 1
            && self.kind == "editing"
            && self.scope == *scope
            && self.view_id == view_id
            && (1..=MAX_SAFE_INTEGER).contains(&self.revision)
            && (1..=MAX_SAFE_INTEGER).contains(&self.writer_generation)
    }
}
