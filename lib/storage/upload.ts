import 'server-only';
import { db } from '@/lib/db/client';
import { BUCKET, ACCEPTED_MIME, type AcceptedMime } from './constants';

export type SignedUpload = {
  storagePath: string;
  signedUrl: string;
  token: string;
};

export async function createSignedUpload(mime: AcceptedMime): Promise<SignedUpload> {
  const ext = ACCEPTED_MIME[mime];
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const id = crypto.randomUUID();
  const storagePath = `${day}/${id}.${ext}`;

  const { data, error } = await db().storage.from(BUCKET).createSignedUploadUrl(storagePath);
  if (error) throw error;
  return { storagePath, signedUrl: data.signedUrl, token: data.token };
}
