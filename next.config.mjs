/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `ws` picks between a native buffer-masking addon and a pure-JS fallback
  // at require time; bundling it breaks that check ("bufferUtil.mask is not
  // a function"). Left external, it's just required by Node as normal.
  serverExternalPackages: ["ws"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
    ];
  },
};

export default nextConfig;
