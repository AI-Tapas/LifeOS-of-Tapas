import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // OAuth discovery has to sit at the domain root, and Next's router ignores
  // dot-prefixed folders, so the well-known paths are rewritten onto real
  // route handlers.
  async rewrites() {
    return [
      {
        source: "/.well-known/oauth-authorization-server",
        destination: "/api/mcp/oauth/metadata",
      },
      {
        source: "/.well-known/oauth-authorization-server/:path*",
        destination: "/api/mcp/oauth/metadata",
      },
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/api/mcp/oauth/resource",
      },
      {
        source: "/.well-known/oauth-protected-resource/:path*",
        destination: "/api/mcp/oauth/resource",
      },
    ];
  },

  experimental: {
    // Keep visited pages warm in the client router cache so bottom-nav
    // switches are instant. Own mutations bypass this via router.refresh();
    // external calendar changes arrive on the next visit or manual Refresh.
    staleTimes: {
      dynamic: 120,
      static: 300,
    },
  },
};

export default nextConfig;
