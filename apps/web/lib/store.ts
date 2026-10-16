import { create } from "zustand";
type WorkspaceState = { selectedRoadId: string | null; setSelectedRoadId: (id: string | null) => void; tab: "workspace" | "analytics"; setTab: (tab: "workspace" | "analytics") => void };
export const useWorkspace = create<WorkspaceState>((set) => ({ selectedRoadId: null, setSelectedRoadId: (selectedRoadId) => set({ selectedRoadId }), tab: "workspace", setTab: (tab) => set({ tab }) }));

