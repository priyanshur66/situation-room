"use client";
import dynamic from "next/dynamic";
import { Dashboard } from "./dashboard";
const WalletRoom = dynamic(() => import("./wallet-room"), {
  ssr: false,
  loading: () => <Dashboard />,
});
export function Application() {
  if (
    !process.env.NEXT_PUBLIC_PRIVY_APP_ID ||
    !process.env.NEXT_PUBLIC_CONVEX_URL
  )
    return <Dashboard />;
  return <WalletRoom />;
}
