import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

export function useSession(token: string) {
  return { logout: useMutation(api.auth.logout), session: useQuery(api.auth.currentSession, { token: token || undefined }) };
}
export function useStaffLogin() { return useAction(api.auth.login); }
export function useCustomerAuth() { return { register: useAction(api.customers.register), login: useAction(api.customers.login) }; }
export function useProjects(token: string) { return useQuery(api.projects.listProjects, { token }); }
export function useCreateProject() { return useMutation(api.projects.createProject); }
export function useProjectMembers(token: string, projectId: Id<"projects">, open: boolean) {
  return { members: useQuery(api.projects.listProjectMembers, open ? { token, projectId } : "skip"),
    addMember: useMutation(api.projects.addProjectMember), removeMember: useMutation(api.projects.removeProjectMember) };
}
