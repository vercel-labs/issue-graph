export default {
  output: "export",
  assetPrefix: ".",
  images: { unoptimized: true },
  webpack(config) {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};
