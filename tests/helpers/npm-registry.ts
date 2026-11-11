/**
 * Fake npm registry for update tests. Serves the @photon-ai/cli
 * packument with the given dist-tags on a kernel-assigned loopback port.
 */
export interface FakeNpmRegistry {
  url: string;
  setDistTags(distTags: Record<string, string>): void;
  stop(): void;
}

export function startNpmRegistry(distTags: Record<string, string>): FakeNpmRegistry {
  let tags = distTags;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/@photon-ai%2Fcli") {
        return new Response("not found", { status: 404 });
      }
      const versions = Object.fromEntries(
        Object.values(tags).map((version) => [
          version,
          { name: "@photon-ai/cli", version },
        ])
      );
      return Response.json({
        name: "@photon-ai/cli",
        "dist-tags": tags,
        versions,
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    setDistTags(next) {
      tags = next;
    },
    stop: () => server.stop(),
  };
}
