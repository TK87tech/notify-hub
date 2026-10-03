import { createContext, useContext } from "react";

/**
 * Connection state for the notification socket.
 *
 * In its own module so `RealtimeProvider` exports nothing but a component: with
 * react-refresh, a file that also exports a hook cannot be hot-reloaded, so
 * editing the provider would remount every screen that reads the state.
 */
export type ConnectionState = "disconnected" | "connecting" | "connected";

export interface RealtimeValue {
  state: ConnectionState;
}

export const RealtimeContext = createContext<RealtimeValue>({ state: "disconnected" });

export function useRealtime(): RealtimeValue {
  return useContext(RealtimeContext);
}