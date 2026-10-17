import { DASHBOARD_CSS } from "@core/dashboard-style";
import type { ReactNode } from "react";
import "./globals.css";
export const metadata = {
  description: "Explore captured issues and pull requests.",
};
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style>{DASHBOARD_CSS}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
