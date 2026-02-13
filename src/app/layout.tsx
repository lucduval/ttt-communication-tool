import type { Metadata } from "next";
import { Inter, Roboto } from "next/font/google";
import "./globals.css";
import { ConvexClientProvider } from "@/components/providers/ConvexClientProvider";


const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const roboto = Roboto({
  weight: ["100", "300", "400", "500", "700", "900"],
  variable: "--font-roboto",
  subsets: ["latin"],
});

import { AuthGuard } from "@/components/auth/AuthGuard";

import { MainLayout } from "@/components/layout/MainLayout";

export const metadata: Metadata = {
  title: "TTT Connect",
  description: "Send bulk emails and WhatsApp messages to your clients",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${roboto.variable} antialiased`} suppressHydrationWarning>
        <ConvexClientProvider>
          <AuthGuard>
            <MainLayout>
              {children}
            </MainLayout>
          </AuthGuard>
        </ConvexClientProvider>
      </body>
    </html>
  );
}
