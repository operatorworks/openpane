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
            } => {
                let source = self
                    .document(broker, label, &incarnation)?
                    .scope
                    .as_ref()
                    .ok_or("child-only")?;
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
                let _ = app.emit_to("main", "openpane-ui-wakeup", ());
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
                    let count = profile.pending_intents(&source.host_id).count();
                    let intent = profile
                        .intents
                        .get_mut(&crate::chat_window_records::Profile::intent_key(
                            &source,
                            &request_id,
                        ))
                        .ok_or("unknown-intent")?;
                    if intent.result.is_some()
                        && count >= crate::chat_window_records::MAX_PENDING_INTENTS
                    {
                        return Err("native-intent-capacity");
                    }
                    intent.result = None;
                    Ok(intent.clone())
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
                            .is_some_and(|host| host.0 == reservation.scope.host_id)
                            && !matches!(reservation.phase, Phase::TargetReady)
                            && !broker.opening.contains_key(&reservation.label)
                    })
                    .collect();
                Ok(json!(pending))
            }
            Command::PendingIntents { incarnation } => {
                self.require_main(broker, label, &incarnation)?;
                let host = &broker.host.as_ref().ok_or("ui-context-not-bound")?.0;
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
            } => {
                self.require_main(broker, label, &incarnation)?;
                self.require_host(broker, &scope)?;
                self.retire_window_history(broker)?;
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
                let intent = broker.storage.mutate(&self.origin, |profile| {
                    profile.assign_intent(&source_scope, &request_id, reservation)
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
