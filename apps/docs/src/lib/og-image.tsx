import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { siteName } from "./site";

let fonts: Promise<[Buffer, Buffer]> | undefined;

export function OgImage({ title }: { title: string }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#000000",
        padding: "60px 80px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <svg
          width="36"
          height="36"
          viewBox="0 0 16 16"
          fill="#ffffff"
          role="img"
          aria-label="Vercel"
        >
          <path fillRule="evenodd" clipRule="evenodd" d="M8 1L16 15H0L8 1Z" />
        </svg>
        <span style={{ fontFamily: "Geist", fontSize: 36, fontWeight: 400, color: "#666666" }}>
          /
        </span>
        <span
          style={{
            fontFamily: "GeistPixelSquare",
            fontSize: 36,
            fontWeight: 400,
            color: "#ffffff",
          }}
        >
          {siteName}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          flex: 1,
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {title.split("\n").map((line) => (
          <span
            key={line}
            style={{
              fontFamily: "Geist",
              fontSize: 72,
              fontWeight: 400,
              color: "#ffffff",
              letterSpacing: "-0.02em",
              textAlign: "center",
              lineHeight: 1.2,
              maxWidth: "100%",
            }}
          >
            {line}
          </span>
        ))}
      </div>
    </div>
  );
}

export async function renderOgImage(title: string) {
  fonts ??= Promise.all([
    readFile(join(process.cwd(), "public/og-fonts/Geist-Regular.ttf")),
    readFile(join(process.cwd(), "public/og-fonts/GeistPixel-Square.ttf")),
  ]);
  const [regular, pixel] = await fonts;
  return new ImageResponse(<OgImage title={title} />, {
    width: 1200,
    height: 630,
    headers: { "Cache-Control": "public, max-age=3600" },
    fonts: [
      { name: "Geist", data: Uint8Array.from(regular).buffer, style: "normal", weight: 400 },
      {
        name: "GeistPixelSquare",
        data: Uint8Array.from(pixel).buffer,
        style: "normal",
        weight: 400,
      },
    ],
  });
}
