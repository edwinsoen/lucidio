import { useCallback, useEffect, useRef } from 'react';
import type { AppState, Generation, GenerationReferenceSelection, ModelCatalog, ReferenceMedia } from '../types';
import { api, type GenerateStatusResponse } from '../lib/api';
import { PALS } from '../lib/data';
import { generationStatusLabel, isImageAsset, isVideoAsset, storedMediaAssetPayload } from '../lib/generationMedia';
import { modeLabel, modelById } from '../lib/modelCatalog';
import { notifyGenerationComplete, requestGenerationNotificationPermission } from '../lib/notifications';
import { recordUsage } from '../lib/usageMeter';
import { defaultReferenceIntent, referenceIntentOptions } from '../lib/referenceIntents';
import { nextSequence, queuedGenerationFromControls, type StudioAction } from '../state/studioReducer';
import type { GenerationEntry } from '../state/studioSelectors';
import type { UiAction } from '../state/uiReducer';

function failureLabel(mode: 'image' | 'video' | undefined): string {
  return `Failed to generate ${mode ?? 'image'}`;
}

export function useGenerationJobs({
  state,
  modelCatalog,
  genIndex,
  hydrated,
  dispatchStudio,
  dispatchUi
}: {
  state: AppState;
  modelCatalog: ModelCatalog | null;
  genIndex: Map<string, GenerationEntry>;
  hydrated: boolean;
  dispatchStudio: React.Dispatch<StudioAction>;
  dispatchUi: React.Dispatch<UiAction>;
}) {
  const resumedJobs = useRef(new Set<string>());
  const statusStreams = useRef(new Map<string, EventSource>());
  const streamErrorNotified = useRef(new Set<string>());
  const notifiedJobs = useRef(new Set<string>());
  const jobNotificationMeta = useRef(new Map<string, { generationId: string; mode: 'image' | 'video'; modelId: string; prompt: string }>());
  const notificationPermissionRequest = useRef<ReturnType<typeof requestGenerationNotificationPermission> | null>(null);
  const lastSequence = useRef(0);

  const applyStatus = useCallback((jobId: string, generationId: string, status: GenerateStatusResponse) => {
    const patch: Partial<Generation> = { status: status.status, progress: status.progress, error: status.error };
    if (status.result?.media) patch.media = status.result.media;
    dispatchStudio({ type: 'patch-generation', generationId, patch });
    dispatchUi({ type: 'api-status', apiStatus: `${generationStatusLabel(status.status)} · ${status.progress?.label ?? jobId}` });
    if (status.status === 'complete' && !notifiedJobs.current.has(jobId)) {
      notifiedJobs.current.add(jobId);
      const meta = jobNotificationMeta.current.get(jobId);
      if (meta) {
        const usage = status.result?.usage;
        void recordUsage({
          jobId,
          modelId: meta.modelId,
          mode: meta.mode,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          totalTokens: usage?.totalTokens ?? 0,
          createdAt: new Date().toISOString()
        }).catch(() => undefined);
      }
      void notifyGenerationComplete({
        jobId,
        mode: meta?.mode ?? (status.result?.media.kind === 'video' ? 'video' : status.result?.media.kind === 'image' ? 'image' : undefined),
        prompt: meta?.prompt
      }, notificationPermissionRequest.current).catch(() => undefined);
    }
    return status.status === 'complete' || status.status === 'failed' || status.status === 'cancelled';
  }, [dispatchStudio, dispatchUi]);

  const subscribeJob = useCallback((jobId: string, generationId: string) => {
    if (statusStreams.current.has(jobId)) return;
    if (typeof EventSource === 'undefined') {
      void api.status(jobId).then((status) => {
        if (applyStatus(jobId, generationId, status)) jobNotificationMeta.current.delete(jobId);
      }).catch(() => {
        const label = failureLabel(jobNotificationMeta.current.get(jobId)?.mode);
        dispatchStudio({ type: 'patch-generation', generationId, patch: { status: 'failed', error: label } });
        dispatchUi({ type: 'api-status', apiStatus: label });
      });
      return;
    }

    const source = new EventSource(api.eventsUrl(jobId));
    statusStreams.current.set(jobId, source);
    source.addEventListener('status', (event) => {
      try {
        streamErrorNotified.current.delete(jobId);
        const payload = JSON.parse(event.data) as GenerateStatusResponse | { ok?: false; error?: string; details?: string };
        if (payload.ok === false) {
          source.close();
          statusStreams.current.delete(jobId);
          const label = failureLabel(jobNotificationMeta.current.get(jobId)?.mode);
          dispatchStudio({ type: 'patch-generation', generationId, patch: { status: 'failed', error: label } });
          dispatchUi({ type: 'api-status', apiStatus: label });
          return;
        }
        const terminal = applyStatus(jobId, generationId, payload as GenerateStatusResponse);
        if (terminal) {
          resumedJobs.current.add(jobId);
          source.close();
          statusStreams.current.delete(jobId);
          jobNotificationMeta.current.delete(jobId);
        }
      } catch {
        source.close();
        statusStreams.current.delete(jobId);
        jobNotificationMeta.current.delete(jobId);
        dispatchStudio({
          type: 'patch-generation',
          generationId,
          patch: { status: 'failed', error: failureLabel(jobNotificationMeta.current.get(jobId)?.mode) }
        });
        dispatchUi({ type: 'api-status', apiStatus: failureLabel(jobNotificationMeta.current.get(jobId)?.mode) });
      }
    });
    source.onerror = () => {
      if (streamErrorNotified.current.has(jobId)) return;
      streamErrorNotified.current.add(jobId);
      dispatchUi({ type: 'api-status', apiStatus: `Waiting for status stream · ${jobId}` });
    };
  }, [applyStatus, dispatchStudio, dispatchUi]);

  useEffect(() => {
    if (!hydrated) return;
    for (const { generation } of genIndex.values()) {
      if (generation.jobId && (generation.status === 'queued' || generation.status === 'running' || generation.status === 'uploading') && !resumedJobs.current.has(generation.jobId)) {
        resumedJobs.current.add(generation.jobId);
        jobNotificationMeta.current.set(generation.jobId, { generationId: generation.id, mode: generation.type, modelId: generation.modelId, prompt: generation.prompt });
        subscribeJob(generation.jobId, generation.id);
      }
    }
  }, [hydrated, genIndex, subscribeJob]);

  useEffect(() => () => {
    for (const source of statusStreams.current.values()) source.close();
    statusStreams.current.clear();
    streamErrorNotified.current.clear();
    jobNotificationMeta.current.clear();
  }, []);

  const generate = useCallback(async (): Promise<boolean> => {
    const snapshot = state;
    dispatchUi({ type: 'api-status', apiStatus: 'Validating generation request…' });
    try {
      const model = modelById(modelCatalog, snapshot.ctl.modelId);
      if (!snapshot.activeProjectId || !snapshot.activeSceneId || !model) return false;
      if (!notificationPermissionRequest.current) notificationPermissionRequest.current = requestGenerationNotificationPermission();
      const references: ReferenceMedia[] = [];
      const referenceSelections: GenerationReferenceSelection[] = [];
      const staleReferenceIds: string[] = [];
      for (const id of snapshot.refIds) {
        const generation = genIndex.get(id)?.generation;
        if (!generation) {
          staleReferenceIds.push(id);
          continue;
        }
        if (!generation.media) {
          dispatchUi({ type: 'api-status', apiStatus: 'Selected references must be completed object-storage media.' });
          return false;
        }
        const selectedIntent = snapshot.referenceSelections?.find((selection) => selection.generationId === id)?.intent ?? defaultReferenceIntent(model, generation);
        const options = referenceIntentOptions(model, generation);
        if (snapshot.ctl.mode === 'image') {
          if (!isImageAsset(generation.media)) {
            dispatchUi({ type: 'api-status', apiStatus: 'Image generation references must be completed object-storage images.' });
            return false;
          }
          references.push({ id: generation.id, intent: 'image_reference', media: storedMediaAssetPayload(generation.media) });
          referenceSelections.push({ generationId: generation.id, intent: 'image_reference' });
        } else {
          if (!selectedIntent || !options.includes(selectedIntent)) {
            dispatchUi({ type: 'api-status', apiStatus: `${generation.prompt || generation.id} is not compatible with ${model.displayName} references.` });
            return false;
          }
          references.push({
            id: generation.id,
            intent: selectedIntent,
            media: storedMediaAssetPayload(generation.media),
            thumbnail: generation.media.thumbnail ? storedMediaAssetPayload(generation.media.thumbnail) : undefined,
            providerTask: generation.media.providerTask
          });
          referenceSelections.push({ generationId: generation.id, intent: selectedIntent });
        }
      }
      if (model.provider === 'byteplus' && model.family === 'seedream' && model.id.includes('seedream-5-0-') && snapshot.ctl.mode === 'image') {
        for (const reference of snapshot.uploadedReferences ?? []) {
          if (reference.projectId !== snapshot.activeProjectId) continue;
          references.push({ id: reference.id, intent: 'image_reference', media: storedMediaAssetPayload(reference.media) });
        }
      }
      if (staleReferenceIds.length) dispatchStudio({ type: 'prune-references' });
      dispatchUi({ type: 'api-status', apiStatus: 'Posting generation request…' });
      const response = await api.generate({ ...snapshot.ctl, references, referenceSelections, projectId: snapshot.activeProjectId, sceneId: snapshot.activeSceneId });
      const seq = Math.max(nextSequence(snapshot), lastSequence.current + 1);
      lastSequence.current = seq;
      const generation = queuedGenerationFromControls(snapshot, response.jobId, seq, Math.floor(Math.random() * PALS.length), new Date().toISOString());
      if (!generation) return false;
      dispatchStudio({ type: 'insert-generation', generation, seq });
      dispatchUi({ type: 'api-status', apiStatus: `Generation queued · ${response.jobId}` });
      resumedJobs.current.add(response.jobId);
      jobNotificationMeta.current.set(response.jobId, { generationId: generation.id, mode: generation.type, modelId: generation.modelId, prompt: generation.prompt });
      subscribeJob(response.jobId, generation.id);
      return true;
    } catch (error) {
      dispatchUi({ type: 'api-status', apiStatus: `Generation rejected (${error instanceof Error ? error.message : 'unknown error'})` });
      return false;
    }
  }, [dispatchStudio, dispatchUi, genIndex, modelCatalog, state, subscribeJob]);

  const toggleReference = useCallback((generationId: string) => {
    const selected = genIndex.get(generationId)?.generation;
    const adding = !state.refIds.includes(generationId);
    if (adding && !selected?.media) {
      dispatchUi({ type: 'api-status', apiStatus: 'Only completed object-storage media can be used as references.' });
      return;
    }
    const model = modelById(modelCatalog, state.ctl.modelId);
    const intent = selected && model?.modality === 'video' && isVideoAsset(selected.media) && referenceIntentOptions(model, selected).includes('source_video')
      ? 'source_video'
      : selected ? defaultReferenceIntent(model, selected) : null;
    if (adding && !intent) {
      dispatchUi({ type: 'api-status', apiStatus: `This generation is not compatible as a ${modeLabel(state.ctl.mode).toLowerCase()} reference.` });
      return;
    }
    dispatchStudio({ type: 'toggle-reference', generationId, intent: intent! });
  }, [dispatchStudio, dispatchUi, genIndex, modelCatalog, state.ctl.mode, state.ctl.modelId, state.refIds]);

  return { generate, toggleReference };
}
