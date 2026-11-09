import type { FastifyReply } from "fastify";

/* A release reaches open browsers on their next load: the page is always revalidated, and the bundles it names carry a
   content hash, so they can be kept for a year. Other files keep the hour the static plugin gives them (server.ts). */
export function cacheHeaders(reply: Pick<FastifyReply, "header">, file: string): void {
  if (file.endsWith(".html")) reply.header("Cache-Control", "no-cache");
  else if (/[\\/]assets[\\/][^\\/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(file)) reply.header("Cache-Control", "public, max-age=31536000, immutable");
}
