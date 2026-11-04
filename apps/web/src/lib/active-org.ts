import type { MeMembership } from '@vime/contracts';
import { featureSet, landingSegment } from './nav';

const STORAGE_KEY = 'vime.activeOrgId';

export function readStoredOrgId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeOrgId(orgId: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, orgId);
  } catch {
    // Storage disabled (private mode): the org is simply not remembered.
  }
}

/** The membership to open: the remembered organization when still a member, else the first one. */
export function pickMembership(
  memberships: readonly MeMembership[],
  storedOrgId: string | null,
): MeMembership | null {
  return (
    memberships.find((m) => m.organization.id === storedOrgId) ??
    [...memberships].sort((a, b) => a.organization.name.localeCompare(b.organization.name))[0] ??
    null
  );
}

/** Memberships with at least one page on this website (a membership with no visible page has none). */
export function webMemberships(memberships: readonly MeMembership[]): MeMembership[] {
  return memberships.filter(
    (m) => landingSegment(new Set(m.permissions), featureSet(m.features)) !== null,
  );
}

/** The platform suspended the organization (ADR 0015): its pages answer 403, show why instead. */
export function isSuspended(membership: MeMembership): boolean {
  return membership.organization.suspended === true;
}
