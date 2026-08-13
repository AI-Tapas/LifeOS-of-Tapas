import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
