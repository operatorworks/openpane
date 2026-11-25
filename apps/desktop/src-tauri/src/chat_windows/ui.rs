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
                broker.bind_host(host_id, profile_id)?;
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
                if children.len() > 32 {
                    return Err("too-many-child-snapshots");
                }
                let mut scoped = BTreeMap::new();
                for child in children {
                    if !broker.documents.values().any(|document| {
                        document.scope.is_some() && document.incarnation == child.incarnation
                    }) {
                        continue;
                    }
                    if serde_json::to_vec(&child.envelope)
                        .map_err(|_| "invalid-ui-state")?
                        .len()
                        > 1024 * 1024
                    {
                        return Err("invalid-ui-state");
                    }
                    if let Some(delivery) = &child.display {
                        let document = broker
                            .documents
                            .values()
                            .find(|document| document.incarnation == child.incarnation)
                            .ok_or("stale-child-snapshot")?;
                        let identity =
                            if delivery.get("kind").and_then(Value::as_str) == Some("page") {
                                delivery.get("page")
                            } else {
                                Some(delivery)
                            }
                            .ok_or("invalid-ui-state")?;
                        if identity.get("scope")
                            != document
                                .scope
                                .as_ref()
                                .and_then(|scope| serde_json::to_value(scope).ok())
                                .as_ref()
                        {
                            return Err("foreign-child-display");
                        }
                    }
                    let previous = broker.child_snapshots.get(&child.incarnation);
                    let display = child
                        .display
                        .or_else(|| previous.and_then(|value| value.get("display")).cloned())
                        .unwrap_or(Value::Null);
                    if serde_json::to_vec(&display)
                        .map_err(|_| "invalid-ui-state")?
                        .len()
                        > 512 * 1024
                    {
                        return Err("invalid-ui-state");
                    }
                    if scoped
                        .insert(
                            child.incarnation,
                            json!({"envelope":child.envelope,"display":display}),
                        )
                        .is_some()
                    {
                        return Err("duplicate-child-snapshot");
                    }
                }
                if !broker.publish_snapshot(snapshot, scoped)? {
                    return Ok(json!({"ok":true}));
                }
                broker.notify_child_cache(app);
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
                    json!({"state":state,"localBuiltin":broker.visual_builtin(),"recoveryFloor":broker.bound_recovery_floor(),"context":self.context(broker,label,document)}),
                )
            }
            Command::Presence {
                incarnation,
                visible,
                display,
            } => {
                self.document(broker, label, &incarnation)?;
                let document = broker.documents.get_mut(label).ok_or("stale-document")?;
                if let Some(subscription) = &display {
                    if serde_json::to_vec(subscription)
                        .map_err(|_| "invalid-display-subscription")?
                        .len()
                        > 8192
                        || subscription.get("scope")
                            != document
                                .scope
                                .as_ref()
                                .and_then(|scope| serde_json::to_value(scope).ok())
                                .as_ref()
                        || subscription
                            .get("subscriptionId")
                            .and_then(Value::as_str)
                            .is_none()
                        || subscription.get("cursor").is_none()
                    {
                        return Err("invalid-display-subscription");
                    }
                }
                let visibility_changed = document.visible != visible;
                document.display = display;
                document.visible = visible;
                let presence_sequence = broker.advance_presence(label)?;
                if visibility_changed {
                    let _ = app.emit_to("main", "openpane-ui-wakeup", ());
                }
                Ok(json!({"presenceSequence":presence_sequence}))
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
                let labels: Vec<_> = broker
                    .documents
                    .keys()
                    .filter(|target| target.as_str() != "main")
                    .cloned()
                    .collect();
                for target in labels {
                    broker.advance_presence(&target)?;
                }
                let contexts: Vec<_> = broker.documents.iter().filter(|(target,document)| target.as_str() != "main" && document.ready).filter_map(|(target,document)|self.context(broker,target,document).map(|context|json!({"context":context,"visible":document.visible,"presenceSequence":document.presence_sequence,"display":document.display,"placement":document.scope.as_ref().and_then(|scope|broker.storage.profile(&self.origin).ok()?.windows.get(&scope.key())).and_then(|entry|entry.binding_revision.map(|revision|json!({"nativeTransitionId":entry.transition_id,"bindingRevision":revision})))}))).collect();
                Ok(
                    json!({"children":contexts,"reports":broker.reports.values().collect::<Vec<_>>(),"localBuiltin":broker.visual_builtin()}),
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
