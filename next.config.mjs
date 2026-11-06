/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the MongoDB driver as a normal Node dependency instead of bundling it.
  serverExternalPackages: ['mongodb'],
  async rewrites() {
    return {
      // The app itself is the static page in public/ (index.html + style.css + script.js).
      beforeFiles: [{ source: '/', destination: '/index.html' }],
    };
  },
};

export default nextConfig;
