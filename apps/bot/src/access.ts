export interface Allowlist {
  userIds: readonly string[];
  roleIds: readonly string[];
}

/** A user is allowed if their ID or any of their role IDs is allowlisted. Empty allowlist = nobody. */
export function isAllowed(
  allowlist: Allowlist,
  userId: string,
  roleIds: Iterable<string>,
): boolean {
  if (allowlist.userIds.includes(userId)) return true;
  for (const roleId of roleIds) {
    if (allowlist.roleIds.includes(roleId)) return true;
  }
  return false;
}
