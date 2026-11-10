import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "轻记账",
  description: "本地优先、支持家庭共享和离线自动补偿同步的轻量记账应用。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: "/icons/apple-touch-icon.png",
  },
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "轻记账",
  },
  other: {
    "color-scheme": "light dark",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f1eb" },
    { media: "(prefers-color-scheme: dark)", color: "#101512" },
  ],
};

const appleStartupImages = [
  { href: "/splash/launch-640x1136.png", media: "screen and (device-width: 320px) and (device-height: 568px) and (-webkit-device-pixel-ratio: 2)" },
  { href: "/splash/launch-750x1334.png", media: "screen and (device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2)" },
  { href: "/splash/launch-828x1792.png", media: "screen and (device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2)" },
  { href: "/splash/launch-1080x2340.png", media: "screen and (device-width: 360px) and (device-height: 780px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/splash/launch-1125x2436.png", media: "screen and (device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/splash/launch-1170x2532.png", media: "screen and (device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/splash/launch-1179x2556.png", media: "screen and (device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/splash/launch-1206x2622.png", media: "screen and (device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/splash/launch-1242x2688.png", media: "screen and (device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/splash/launch-1284x2778.png", media: "screen and (device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/splash/launch-1290x2796.png", media: "screen and (device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3)" },
  { href: "/splash/launch-1320x2868.png", media: "screen and (device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3)" },
] as const;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {appleStartupImages.map((image) => (
          <link key={`${image.href}:light`} rel="apple-touch-startup-image" href={`${image.href}?v=2`} media={`${image.media} and (prefers-color-scheme: light)`} />
        ))}
        {appleStartupImages.map((image) => (
          <link key={`${image.href}:dark`} rel="apple-touch-startup-image" href={`${image.href.replace("/launch-", "/launch-dark-")}?v=2`} media={`${image.media} and (prefers-color-scheme: dark)`} />
        ))}
      </head>
      <body>{children}</body>
    </html>
  );
}
