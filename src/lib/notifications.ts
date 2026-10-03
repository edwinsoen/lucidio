import type { OutputMode } from '../types';

type NotificationPermissionResult = NotificationPermission | 'unsupported';

const MAX_PROMPT_BODY_CHARS = 120;

export interface GenerationNotificationInput {
  jobId: string;
  mode?: OutputMode;
  prompt?: string;
}

export function generationCompleteNotificationBody(input: GenerationNotificationInput): string {
  const kind = input.mode === 'video' ? 'Video generation' : input.mode === 'image' ? 'Image generation' : 'Your generation';
  const prompt = input.prompt?.trim();
  if (!prompt) return `${kind} is ready.`;
  const normalized = prompt.replace(/\s+/g, ' ');
  const clipped = normalized.length > MAX_PROMPT_BODY_CHARS ? `${normalized.slice(0, MAX_PROMPT_BODY_CHARS - 1)}...` : normalized;
  return `${kind} is ready: ${clipped}`;
}

export async function requestGenerationNotificationPermission(): Promise<NotificationPermissionResult> {
  if (!supportsNotifications()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

export async function notifyGenerationComplete(input: GenerationNotificationInput, pendingPermission?: Promise<NotificationPermissionResult> | null): Promise<boolean> {
  if (!supportsNotifications()) return false;
  if (Notification.permission === 'default' && pendingPermission) await pendingPermission.catch(() => 'default');
  if (Notification.permission !== 'granted') return false;
  new Notification('Lucidio generation complete', {
    body: generationCompleteNotificationBody(input),
    tag: `lucidio-generation-${input.jobId}`
  });
  return true;
}

function supportsNotifications(): boolean {
  return typeof Notification !== 'undefined' && typeof Notification.requestPermission === 'function';
}
