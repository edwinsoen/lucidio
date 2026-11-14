import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { Generation, GenerationControls, GenerationReferenceSelection, ModelCatalog, ModelCatalogEntry, OutputMode, UploadedReference, VideoReferenceIntent } from '../types';
import { api } from '../lib/api';
import { mediaUrlFromCache, type MediaUrlCache, type ResolveMediaUrl } from '../app/useMediaUrls';
import { palStyle } from '../lib/data';
import { advancedParameters, modeLabel, modelsForMode, supportsAudio, supportsCamera, supportsGuidance, supportsSeed } from '../lib/modelCatalog';
import type { ParamPatch } from '../lib/modelCatalog';
import { mediaUrlCacheKey, previewAssetRole } from '../lib/generationMedia';
import { defaultReferenceIntent, referenceIntentLabel, referenceIntentOptions } from '../lib/referenceIntents';
import { useRecoveringMediaUrl } from '../lib/useRecoveringMediaUrl';
import { AdvancedParamField, DurationControl, SelectOrText, Toggle } from './controls';

export function Sidebar({ catalog, controls, currentModel, references, uploadedReferences, uploadingReference, referenceSelections, mediaUrls, apiStatus, canGenerate, generating, composerOpen, onCloseComposer, onSetMode, onControls, onReferenceIntent, onRemoveRef, onUploadReference, onRemoveUploadedReference, onGenerate, onResolveMediaUrl }: {
  catalog: ModelCatalog | null;
  controls: GenerationControls;
  currentModel: ModelCatalogEntry | null;
  references: Generation[];
  uploadedReferences: UploadedReference[];
  uploadingReference: boolean;
  referenceSelections: GenerationReferenceSelection[];
  mediaUrls: MediaUrlCache;
  apiStatus: string;
  canGenerate: boolean;
  generating: boolean;
  composerOpen: boolean;
  onCloseComposer: () => void;
  onSetMode: (mode: OutputMode) => void;
  onControls: (patch: Partial<GenerationControls> & { params?: ParamPatch }) => void;
  onReferenceIntent: (id: string, intent: VideoReferenceIntent) => void;
  onRemoveRef: (id: string) => void;
  onUploadReference: (file: File) => void;
  onRemoveUploadedReference: (id: string) => void;
  onGenerate: () => void;
  onResolveMediaUrl: ResolveMediaUrl;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canUploadReference = currentModel?.provider === 'byteplus' && currentModel.family === 'seedream' && currentModel.id.includes('seedream-5-0-');
  const imageModels = modelsForMode(catalog, 'image');
  const videoModels = modelsForMode(catalog, 'video');
  const modelOptions = modelsForMode(catalog, controls.mode);
  const isVideo = controls.mode === 'video';
  const ratioOptions = currentModel?.capabilities.aspectRatios ?? [];
  const resolutionOptions = currentModel?.capabilities.resolutions ?? [];
  const fpsOptions = currentModel?.capabilities.frameRates ?? [];
  const duration = currentModel?.capabilities.durationSeconds;
  const advanced = advancedParameters(currentModel);
  const canSeed = supportsSeed(currentModel);
  const canGuidance = supportsGuidance(currentModel);
  const canCamera = supportsCamera(currentModel);
  const canAudio = supportsAudio(currentModel);
  return (
    <aside className={`sidebar ${composerOpen ? 'composer-open' : ''}`}>
      <div className="composer-head"><strong>Create</strong><button onClick={onCloseComposer} aria-label="Close create form"><X size={18} strokeWidth={2.2} /></button></div>
      <div className="sidebar-scroll">
        <section className="field"><div className="label-row"><span>Output</span></div><div className="segment"><button className={!isVideo ? 'selected' : ''} disabled={!imageModels.length} onClick={() => onSetMode('image')}>Image</button><button className={isVideo ? 'selected' : ''} disabled={!videoModels.length} title={videoModels.length ? 'Generate video with configured BytePlus Seedance models' : 'No configured video models available'} onClick={() => onSetMode('video')}>Video</button></div></section>
        <section className="field"><label>Model</label>{modelOptions.length ? <SelectOrText value={controls.modelId} options={modelOptions.map((model) => model.id)} labelFor={(id) => modelOptions.find((model) => model.id === id)?.displayName ?? String(id)} onChange={(modelId) => onControls({ modelId })} /> : <div className="empty-ref">No {modeLabel(controls.mode).toLowerCase()} models available.</div>}<p>{currentModel?.description ?? 'Load the backend model catalog to configure generation.'}</p></section>
        <section className="field"><div className="label-row"><label>Prompt</label><small>{controls.prompt.length} chars</small></div><textarea rows={4} value={controls.prompt} placeholder="Describe the shot…" onChange={(event) => onControls({ prompt: event.target.value })} /></section>
        <section className="field"><div className="label-row"><label>References</label><small>{references.length + uploadedReferences.length} selected</small></div>{references.length || uploadedReferences.length ? <div className="refs">{references.map((generation) => <ReferenceThumb key={generation.id} currentModel={currentModel} generation={generation} selectedIntent={referenceSelections.find((selection) => selection.generationId === generation.id)?.intent ?? defaultReferenceIntent(currentModel, generation)} mediaUrl={mediaUrlFromCache(mediaUrls, mediaUrlCacheKey(generation, previewAssetRole(generation), 'thumbnail'))} onResolveMediaUrl={onResolveMediaUrl} onReferenceIntent={onReferenceIntent} onRemoveRef={onRemoveRef} />)}{uploadedReferences.map((reference) => <UploadedReferenceThumb key={reference.id} reference={reference} onRemove={onRemoveUploadedReference} />)}</div> : <div className="empty-ref">{canUploadReference ? 'Add an image from your device or select a completed generation.' : 'Select completed generated media to use as a reference here. Video models can use image thumbnails, first/last frames, or source videos when supported.'}</div>}{canUploadReference && <><input ref={fileInputRef} className="reference-file-input" type="file" accept="image/jpeg,image/png,image/webp" aria-label="Choose local reference image" onChange={(event) => { const file = event.target.files?.[0]; if (file) onUploadReference(file); event.target.value = ''; }} /><button type="button" className="add-local-reference" disabled={uploadingReference} onClick={() => fileInputRef.current?.click()}><Plus size={15} />{uploadingReference ? 'Uploading reference…' : 'Add from device'}</button></>}</section>
        <div className="rule" />
        {ratioOptions.length > 0 && <section className="field"><label>Aspect ratio</label><div className="chips">{ratioOptions.map((ratio) => <button key={ratio} className={controls.ratio === ratio ? 'selected' : ''} onClick={() => onControls({ ratio })}>{ratio}</button>)}</div></section>}
        {resolutionOptions.length > 0 && <div className="split"><section className="field"><label>Resolution</label><SelectOrText value={controls.res} options={resolutionOptions} onChange={(res) => onControls({ res })} /></section>{isVideo && fpsOptions.length > 0 && <section className="field"><label>Frame rate</label><SelectOrText value={controls.fps} options={fpsOptions} labelFor={(fps) => `${fps} fps`} onChange={(fps) => onControls({ fps: Number(fps) })} /></section>}</div>}
        {isVideo && duration && <DurationControl duration={duration} value={controls.length} onChange={(length) => onControls({ length })} />}
        {isVideo && canCamera && <Toggle label="Camera motion" enabled checked={controls.camera} onToggle={() => onControls({ camera: !controls.camera })} />}
        {isVideo && canAudio && <Toggle label="Audio" enabled checked={controls.audio} onToggle={() => onControls({ audio: !controls.audio })} />}
        {!isVideo && canGuidance && <section className="field"><div className="label-row"><label>Guidance</label><small className="accent">{controls.guidance}</small></div><input type="range" min={1} max={15} step={0.5} value={controls.guidance} onChange={(event) => onControls({ guidance: Number(event.target.value) })} /></section>}
        {canSeed && <section className="field seed-row"><label>Seed</label><div className="seed-box"><div className={`seed-input-wrap ${controls.seed !== '' ? 'has-seed' : ''}`}><input type="text" inputMode="numeric" pattern="[0-9]*" placeholder="random" value={controls.seed} onChange={(event) => { const value = event.target.value.replace(/\D/g, ''); onControls({ seed: value === '' ? '' : Number(value) }); }} />{controls.seed !== '' && <button className="seed-clear" onClick={() => onControls({ seed: '' })} aria-label="Clear seed"><X size={13} strokeWidth={2.4} /></button>}</div><button className="seed-randomize" onClick={() => onControls({ seed: Math.floor(Math.random() * 900000) })} aria-label="Randomize seed">↻</button></div></section>}
        {advanced.length > 0 && <details className="field advanced-section"><summary>Advanced</summary><div className="advanced-grid">{advanced.map((param) => <AdvancedParamField key={param.name} param={param} value={controls.params[param.name]} onChange={(value) => onControls({ params: { [param.name]: value } })} />)}</div></details>}
        <div className="api-status">{apiStatus}</div>
      </div>
      <div className="generate-wrap"><button className="generate" onClick={onGenerate} disabled={!canGenerate || generating || !controls.prompt.trim()}>✦ {generating ? 'Queueing…' : `Generate ${isVideo ? 'video' : 'image'}`}</button></div>
    </aside>
  );
}

function UploadedReferenceThumb({ reference, onRemove }: { reference: UploadedReference; onRemove: (id: string) => void }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    void api.thumbnail({ key: reference.media.key, contentType: reference.media.contentType }).then((blob) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => undefined);
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [reference.media.key, reference.media.contentType]);
  return <div className="ref-item"><div className="ref-thumb">{url && <img className="media-img" src={url} alt={reference.name} />}<button onClick={() => onRemove(reference.id)} aria-label={`Remove ${reference.name}`}><X size={12} strokeWidth={2.5} /></button></div><small className="ref-intent-label" title={reference.name}>{reference.name}</small></div>;
}

export function ReferenceThumb({ currentModel, generation, selectedIntent, mediaUrl, onResolveMediaUrl, onReferenceIntent, onRemoveRef }: {
  currentModel: ModelCatalogEntry | null;
  generation: Generation;
  selectedIntent: VideoReferenceIntent | null;
  mediaUrl?: string;
  onResolveMediaUrl: ResolveMediaUrl;
  onReferenceIntent: (id: string, intent: VideoReferenceIntent) => void;
  onRemoveRef: (id: string) => void;
}) {
  const role = previewAssetRole(generation);
  const thumbnailMedia = useRecoveringMediaUrl(generation, mediaUrl, 'thumbnail', role, onResolveMediaUrl);
  const options = referenceIntentOptions(currentModel, generation);
  useEffect(() => {
    if (generation.media && !mediaUrl) void onResolveMediaUrl(generation, 'thumbnail', role);
  }, [generation.id, generation.media?.key, mediaUrl, onResolveMediaUrl, role]);
  return <div className="ref-item"><div className="ref-thumb" style={palStyle(generation.pal)}>{thumbnailMedia.visibleUrl && <img className="media-img" src={thumbnailMedia.visibleUrl} alt="Reference" onError={thumbnailMedia.onError} />}{generation.type === 'video' && <i className="play mini" aria-hidden="true" />}<button onClick={() => onRemoveRef(generation.id)} aria-label="Remove reference"><X size={12} strokeWidth={2.5} /></button></div>{options.length > 1 ? <select className="ref-intent" value={selectedIntent ?? options[0]} onChange={(event) => onReferenceIntent(generation.id, event.target.value as VideoReferenceIntent)}>{options.map((intent) => <option key={intent} value={intent}>{referenceIntentLabel(intent)}</option>)}</select> : <small className="ref-intent-label">{selectedIntent ? referenceIntentLabel(selectedIntent) : 'Unsupported'}</small>}</div>;
}
