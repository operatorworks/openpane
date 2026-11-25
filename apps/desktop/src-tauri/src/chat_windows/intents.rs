use super::*;

impl ChatWindows {
    pub(super) fn run_intent(
        &self,
        app: &tauri::AppHandle,
        broker: &mut Broker,
        label: &str,
        command: Command,
    ) -> Result<Value, &'static str> {
        match command {
            Command::IntentContext {
                incarnation,
                retire_after,
            } => {
                self.document(broker, label, &incarnation)?;
                let profile = broker.storage.profile(&self.origin)?;
                if profile.intents.len() >= crate::chat_window_records::MAX_INTENTS
                    || retire_after == Some(profile.intent_epoch)
                {
                    broker.storage.mutate(&self.origin, |profile| {
                        profile.compact_terminal_intents(retire_after)
                    })?;
                }
                let profile = broker.storage.profile(&self.origin)?;
                let pending: Vec<_> = profile
                    .intents
                    .values()
                    .filter(|intent| intent.result.is_none())
                    .map(|intent| &intent.request_id)
                    .collect();
                Ok(json!({"epoch":profile.intent_epoch,"pendingCarryRequests":pending}))
            }
            Command::PlacementIntent {
                incarnation,
                request_id,
                action,
            } => {
                let source = self
                    .document(broker, label, &incarnation)?
                    .scope
                    .clone()
                    .ok_or("child-only")?;
                if app.get_webview_window("main").is_none()
                    || !broker.documents.contains_key("main")
                    || broker.main_closing
                {
                    return Err("main-unavailable");
                }
                let intent = broker.storage.mutate(&self.origin, |profile| {
                    profile.intent(source, request_id, action)
                })?;
                let _ = app.emit_to("main", "openpane-placement-intent", ());
                Ok(json!(intent))
            }
            Command::ReadIntent {
                incarnation,
                request_id,
                source_scope,
            } => {
                let document = self.document(broker, label, &incarnation)?;
                let source = if label == "main" {
                    self.require_main(broker, label, &incarnation)?;
                    let source = source_scope.as_ref().ok_or("source-required")?;
                    self.require_host(broker, source)?;
                    source
                } else {
                    let own = document.scope.as_ref().ok_or("child-only")?;
                    if source_scope.as_ref().is_some_and(|source| source != own) {
                        return Err("foreign-intent-source");
                    }
                    own
                };
                Ok(json!(broker.storage.profile(&self.origin)?.intents.get(
                    &crate::chat_window_records::Profile::intent_key(source, &request_id)
                )))
            }
            Command::CarryApplied {
                incarnation,
                source_scope,
                request_id,
            } => {
                let document = self.document(broker, label, &incarnation)?;
                self.require_host(broker, &source_scope)?;
                broker
                    .storage
                    .profile(&self.origin)?
                    .validate_carry_notification(
                        &source_scope,
                        &request_id,
                        document.scope.as_ref(),
                    )?;
                if label != "main" {
                    let _ = app.emit_to("main", "openpane-ui-wakeup", ());
                }
                if let Some((source_label, _)) = broker
                    .documents
                    .iter()
                    .find(|(_, document)| document.scope.as_ref() == Some(&source_scope))
                {
                    let _ = app.emit_to(source_label, "openpane-ui-wakeup", ());
                }
                Ok(json!({"ok":true}))
            }
            Command::RetryIntent {
                incarnation,
                request_id,
            } => {
                let source = self
                    .document(broker, label, &incarnation)?
                    .scope
                    .clone()
                    .ok_or("child-only")?;
                if app.get_webview_window("main").is_none()
                    || !broker.documents.contains_key("main")
                    || broker.main_closing
                {
                    return Err("main-unavailable");
                }
                let intent = broker.storage.mutate(&self.origin, |profile| {
                    profile.retry_intent(&source, &request_id)
                })?;
                let _ = app.emit_to("main", "openpane-placement-intent", ());
                Ok(json!(intent))
            }
            Command::OwnIntents { incarnation, after } => {
                let source = self
                    .document(broker, label, &incarnation)?
                    .scope
                    .as_ref()
                    .ok_or("child-only")?;
                if let Some(cursor) = &after {
                    identifier(cursor, 200)?;
                }
                let owned: Vec<&Intent> = broker
                    .storage
                    .profile(&self.origin)?
                    .intents
                    .values()
                    .filter(|intent| &intent.source_scope == source)
                    .collect();
                let pending: Vec<_> = owned
                    .iter()
                    .copied()
                    .filter(|intent| intent.result.is_none())
                    .collect();
                let mut history: Vec<_> = owned
                    .into_iter()
                    .filter(|intent| {
                        intent.result.is_some()
                            && after
                                .as_ref()
                                .is_none_or(|cursor| intent.request_id.as_str() > cursor.as_str())
                    })
                    .collect();
                history.sort_by(|left, right| left.request_id.cmp(&right.request_id));
                history.truncate(32);
                let cursor = if history.len() == 32 {
                    history.last().map(|intent| intent.request_id.clone())
                } else {
                    None
                };
                Ok(
                    json!({"epoch":broker.storage.profile(&self.origin)?.intent_epoch,"pending":pending,"items":history,"after":cursor}),
                )
            }
            Command::Reservations { incarnation } => {
                self.require_main(broker, label, &incarnation)?;
                let pending: Vec<_> = broker
                    .storage
                    .profile(&self.origin)?
                    .windows
                    .values()
                    .filter(|reservation| {
                        broker
                            .host
                            .as_ref()
                            .is_some_and(|host| host.host_id == reservation.scope.host_id)
                            && !matches!(reservation.phase, Phase::TargetReady | Phase::InlineReady)
                            && !broker.opening.contains_key(&reservation.label)
                    })
                    .collect();
                Ok(json!(pending))
            }
            Command::PendingIntents { incarnation } => {
                self.require_main(broker, label, &incarnation)?;
                let host = &broker.host.as_ref().ok_or("ui-context-not-bound")?.host_id;
                let pending: Vec<&Intent> = broker
                    .storage
                    .profile(&self.origin)?
                    .pending_intents(host)
                    .collect();
                Ok(json!(pending))
            }
            Command::AssignIntent {
                incarnation,
                source_scope,
                request_id,
                scope,
                view_id,
                creation_agent_id,
                current_binding,
            } => {
                self.require_main(broker, label, &incarnation)?;
                self.require_host(broker, &scope)?;
                // Select and assign the current attempt under the same broker lock as readiness.
                let prior_view_id = broker
                    .storage
                    .profile(&self.origin)?
                    .windows
                    .get(&scope.key())
                    .map(|prior| prior.view_id.clone());
                let view_id = match view_id.or(prior_view_id) {
                    Some(view_id) => view_id,
                    None => random_id()?,
                };
                let current_binding =
                    assignment_binding(current_binding.as_ref(), &scope, &view_id)?;
                self.retire_window_history(broker, &scope)?;
                // Allocation and assignment are flushed in the same native-file transaction.
                let reservation = Reservation {
                    scope,
                    view_id,
                    creation_agent_id,
                    label: format!("chat-{}", random_id()?),
                    transition_id: random_id()?,
                    phase: Phase::Requested,
                    binding_revision: None,
                    writer_generation: None,
                };
                let closed = !broker
                    .opening
                    .values()
                    .any(|live| live == &reservation.scope)
                    && !broker
                        .documents
                        .values()
                        .any(|document| document.scope.as_ref() == Some(&reservation.scope));
                let intent = broker.storage.mutate(&self.origin, |profile| {
                    profile.assign_intent(
                        &source_scope,
                        &request_id,
                        reservation,
                        closed,
                        current_binding,
                    )
                })?;
                Ok(json!(intent))
            }
            Command::CompleteIntent {
                incarnation,
                source_scope,
                request_id,
                result,
            } => {
                self.require_main(broker, label, &incarnation)?;
                if serde_json::to_vec(&result)
                    .map_err(|_| "invalid-intent-result")?
                    .len()
                    > 4096
                {
                    return Err("invalid-intent-result");
                }
                broker.storage.mutate(&self.origin, |profile| {
                    profile.complete_intent(&source_scope, &request_id, result)
                })?;
                if let Some(document) = broker
                    .documents
                    .iter()
                    .find(|(_, document)| document.scope.as_ref() == Some(&source_scope))
                {
                    let _ = app.emit_to(document.0, "openpane-ui-wakeup", ());
                }
                Ok(json!({"ok":true}))
            }
            _ => Err("invalid-intents-command"),
        }
    }
}

fn assignment_binding<'a>(
    binding: Option<&'a types::Binding>,
    scope: &Scope,
    view_id: &str,
) -> Result<Option<(&'a Scope, &'a str, u64, u64)>, &'static str> {
    let Some(binding) = binding else {
        return Ok(None);
    };
    if !binding.admits(scope, view_id) {
        return Err("binding-mismatch");
    }
    Ok(Some((
        &binding.scope,
        binding.view_id.as_str(),
        binding.revision,
        binding.writer_generation,
    )))
}

#[cfg(test)]
mod assignment_binding_tests {
    use super::*;
    fn command() -> Value {
        json!({"kind":"assign-intent","incarnation":"main","sourceScope":{"hostId":"host","conversationId":"source"},"requestId":"1:assignment","scope":{"hostId":"host","conversationId":"target"},"viewId":"target-view","creationAgentId":null,"currentBinding":{"schemaVersion":1,"kind":"editing","scope":{"hostId":"host","conversationId":"target"},"viewId":"target-view","revision":3,"writerGeneration":4}})
    }
    fn validate(value: Value) -> Result<bool, &'static str> {
        let parsed: Command = serde_json::from_value(value).map_err(|_| "invalid-input")?;
        let Command::AssignIntent {
            scope,
            view_id,
            current_binding,
            ..
        } = parsed
        else {
            panic!("assignment command");
        };
        assignment_binding(
            current_binding.as_ref(),
            &scope,
            view_id.as_deref().unwrap(),
        )
        .map(|binding| binding.is_some())
    }
    #[test]
    fn assignment_wire_validates_current_binding_before_native_mutation() {
        assert_eq!(validate(command()), Ok(true));
        for (field, invalid) in [
            ("schemaVersion", json!(2)),
            ("kind", json!("handoff-reserved")),
            ("viewId", json!("another-view")),
            ("revision", json!(0)),
            ("writerGeneration", json!(0)),
            ("revision", json!(9007199254740992u64)),
            ("writerGeneration", json!(9007199254740992u64)),
            ("scope", json!({"hostId":"host","conversationId":"other"})),
        ] {
            let mut value = command();
            value["currentBinding"][field] = invalid;
            assert_eq!(validate(value), Err("binding-mismatch"), "{field}");
        }
        for invalid in [json!({}), json!("bad-binding"), json!(false)] {
            let mut value = command();
            value["currentBinding"] = invalid;
            assert_eq!(validate(value), Err("invalid-input"));
        }
        let mut value = command();
        value["currentBinding"]["unexpected"] = json!(true);
        assert_eq!(validate(value), Err("invalid-input"));
    }
    #[test]
    fn absent_binding_is_supported_but_observed_ready_hints_stay_rejected() {
        let mut value = command();
        value["currentBinding"] = Value::Null;
        assert_eq!(validate(value.clone()), Ok(false));
        value.as_object_mut().unwrap().remove("currentBinding");
        assert_eq!(validate(value.clone()), Ok(false));
        value["observedReadyTransitionId"] = json!("obsolete-boolean-observation");
        assert_eq!(validate(value), Err("invalid-input"));
    }
}
