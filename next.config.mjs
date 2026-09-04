/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `ws` picks between a native buffer-masking addon and a pure-JS fallback
  // at require time; bundling it breaks that check ("bufferUtil.mask is not
  // a function"). Left external, it's just required by Node as normal.
  serverExternalPackages: ["ws"],
};

export default nextConfig;
