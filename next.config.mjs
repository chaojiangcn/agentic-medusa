/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next 16 blocks dev resources (HMR websocket, fonts) for cross-origin hosts.
  // The preview can be opened via either localhost or 127.0.0.1; allow both
  // so the client runtime always hydrates and the 3D workshop actually mounts.
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  // react-three-fiber remounts the WebGL canvas under StrictMode's double
  // render, which trips React's "unmount a root while rendering" guard and
  // floods the dev overlay. Keep StrictMode out of the 3D scene.
  reactStrictMode: false,
  // Keep the dev overlay from covering the workshop.
  devIndicators: false,
}

export default nextConfig
