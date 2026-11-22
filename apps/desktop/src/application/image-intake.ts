import { IMAGE_MAX_BYTES } from '@openpane/contracts/image';

const IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg'];
const IMAGE_NAME = /\.(png|jpe?g)$/i;
/** Types some sources report for any file; the name decides for these. */
const GENERIC_TYPES: readonly string[] = ['', 'application/octet-stream'];

export type DropVerdict = { readonly kind: 'accept' } | { readonly kind: 'reject'; readonly reason: string };
export type IntakeResult = { readonly kind: 'file'; readonly file: File } | { readonly kind: 'reject'; readonly reason: string };

export const ONE_IMAGE = 'Drop one image at a time.';
export const IMAGE_TYPE = 'Drop a PNG or JPEG image.';
export const IMAGE_SIZE = 'Choose an image of at most 4 MB.';

/**
 * What a drag over the conversation would do, from what a drag exposes before the drop: item kinds and types, not
 * sizes or names. Text drags are not ours. A generic type (empty, application/octet-stream) is accepted here and decided
 * on drop by file name; any other type that is not PNG or JPEG is refused.
 */
export function dragVerdict(types: readonly string[], items: DataTransferItemList | null, blocked: string | null): 'ignore' | DropVerdict {
  if (!types.includes('Files')) return 'ignore';
  if (blocked) return { kind: 'reject', reason: blocked };
  const files = items ? [...items].filter(item => item.kind === 'file') : [];
  if (files.length > 1) return { kind: 'reject', reason: ONE_IMAGE };
  const type = files[0]?.type ?? '';
  if (!IMAGE_TYPES.includes(type) && !GENERIC_TYPES.includes(type)) return { kind: 'reject', reason: IMAGE_TYPE };
  return { kind: 'accept' };
}

/** The full check once files are in hand. The host remains the authority on content; this only spares a round trip. */
export function intakeFile(files: readonly File[]): IntakeResult {
  if (files.length !== 1) return { kind: 'reject', reason: ONE_IMAGE };
  const [file] = files as [File];
  const typed = IMAGE_TYPES.includes(file.type) || (GENERIC_TYPES.includes(file.type) && IMAGE_NAME.test(file.name));
  if (!typed) return { kind: 'reject', reason: IMAGE_TYPE };
  if (file.size > IMAGE_MAX_BYTES) return { kind: 'reject', reason: IMAGE_SIZE };
  return { kind: 'file', file };
}
