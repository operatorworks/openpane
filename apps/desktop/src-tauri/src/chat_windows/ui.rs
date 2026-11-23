use super::*;

impl ChatWindows {
    pub(super) fn run_ui(
        &self,
        app: &tauri::AppHandle,
        broker: &mut Broker,
        label: &str,
        command: Command,
    ) -> Result<Value, &'static str> {
        match command {
            Command::BindUi {
                incarnation,
                host_id,
                profile_id,
            } => {
                self.require_main(broker, label, &incarnation)?;
                identifier(&host_id, 1024)?;
                identifier(&profile_id, 200)?;
                if broker
                    .host
                    .as_ref()
                    .is_some_and(|previous| previous != &(host_id.clone(), profile_id.clone()))
                {
                    return Err("host-identity-changed");
                }
                broker.host = Some((host_id, profile_id));
                let document = self.document(broker, label, &incarnation)?;
                let mut context = self
                    .context(broker, label, document)
                    .ok_or("ui-context-not-bound")?;
                context
                    .as_object_mut()
                    .ok_or("invalid-context")?
                    .remove("scope");
                Ok(context)
            }
            Command::PublishUi {
                incarnation,
                snapshot,
                children,
            } => {
                self.require_main(broker, label, &incarnation)?;
                if serde_json::to_vec(&snapshot)
                    .map_err(|_| "invalid-ui-state")?
                    .len()
                    > 1024 * 1024
                    || snapshot.get("version") != Some(&json!(1))
                {
                    return Err("invalid-ui-state");
                }
                if snapshot
                    .pointer("/selection/selected/kind")
                    .and_then(Value::as_str)
                    == Some("builtin")
                {
                    broker.local_builtin = false;
                }
                if children.len() > 32 {
                    return Err("too-many-child-snapshots");
                }
                let mut scoped = BTreeMap::new();
                for child in children {
                    if !broker.documents.values().any(|document| {
                        document.scope.is_some() && document.incarnation == child.incarnation
                    }) {
                        return Err("stale-child-snapshot");
                    }
                    if serde_json::to_vec(&child.envelope)
                        .map_err(|_| "invalid-ui-state")?
                        .len()
                        > 1024 * 1024
                    {
                        return Err("invalid-ui-state");
                    }
                    if scoped.insert(child.incarnation, child.envelope).is_some() {
                        return Err("duplicate-child-snapshot");
                    }
                }
                broker.child_snapshots = scoped;
                broker.snapshot = Some(snapshot);
                for target in broker
                    .documents
                    .keys()
                    .filter(|target| target.as_str() != "main")
                {
                    let _ = app.emit_to(target, "openpane-ui-wakeup", ());
                }
                Ok(json!({"ok":true}))
            }
            Command::ReadUi { incarnation } => {
                let document = self.document(broker, label, &incarnation)?;
                let state = if label == "main" {
                    broker.snapshot.clone()
                } else {
                    child_ui_state(
                        broker.snapshot.as_ref(),
                        broker.child_snapshots.get(&incarnation),
                    )
                };
                Ok(
                    json!({"state":state,"localBuiltin":broker.local_builtin,"context":self.context(broker,label,document)}),
                )
            }
            Command::Presence {
                incarnation,
                visible,
            } => {
                self.document(broker, label, &incarnation)?;
                let document = broker.documents.get_mut(label).ok_or("stale-document")?;
                document.visible = visible;
                document.presence_sequence += 1;
                let _ = app.emit_to("main", "openpane-ui-wakeup", ());
                Ok(json!({"ok":true}))
            }
            Command::ReportUi {
                incarnation,
                report,
            } => {
                let document = self.document(broker, label, &incarnation)?;
                if label == "main" || !document.ready {
                    return Err("child-not-ready");
                }
                if serde_json::to_vec(&report)
                    .map_err(|_| "invalid-ui-report")?
                    .len()
                    > 4096
                {
                    return Err("invalid-ui-report");
                }
                let context = self
                    .context(broker, label, document)
                    .ok_or("ui-context-not-bound")?;
                let id = random_id()?;
                if broker.reports.len() >= 64 {
                    return Err("ui-report-backpressure");
                }
                broker.reports.insert(
                    id.clone(),
                    json!({"id":id,"context":context,"report":report}),
                );
                let _ = app.emit_to("main", "openpane-ui-wakeup", ());
                Ok(json!({"ok":true}))
            }
            Command::DrainUi { incarnation } => {
                self.require_main(broker, label, &incarnation)?;
                for (target, document) in &mut broker.documents {
                    if target != "main" {
                        document.presence_sequence += 1;
                    }
                }
                let contexts: Vec<_> = broker.documents.iter().filter(|(target,document)| target.as_str() != "main" && document.ready).filter_map(|(target,document)|self.context(broker,target,document).map(|context|json!({"context":context,"visible":document.visible,"presenceSequence":document.presence_sequence,"placement":document.scope.as_ref().and_then(|scope|broker.storage.profile(&self.origin).ok()?.windows.get(&scope.key())).and_then(|entry|entry.binding_revision.map(|revision|json!({"nativeTransitionId":entry.transition_id,"bindingRevision":revision})))}))).collect();
                Ok(
                    json!({"children":contexts,"reports":broker.reports.values().collect::<Vec<_>>(),"localBuiltin":broker.local_builtin}),
                )
            }
            Command::ConfirmUi { incarnation, ids } => {
                self.require_main(broker, label, &incarnation)?;
                if ids.len() > 64 {
                    return Err("invalid-ui-confirmation");
                }
                for id in ids {
                    broker.reports.remove(&id);
                }
                Ok(json!({"ok":true}))
            }
            _ => Err("invalid-ui-command"),
        }
    }
}
