/** The shapes the service sends. Money fields are always base-10 strings. */

export interface ElementInfo {
  index: number;
  id: string;
  name: string;
  hex: string;
  glyph: string;
}

export interface BetInfo {
  code: string;
  name: string;
  tier: 'FLOW' | 'FORM' | 'ORDER';
  picks: string;
  rule: string;
  shape: 'A' | 'B' | 'C' | 'D' | 'E';
  orderedPair: boolean | null;
  multiplier: string | null;
  multiplierDecimal: string;
  probability: string | null;
  medianRoundsToFirstHit: number | null;
  variance: string | null;
  rtp: string | null;
  instances: number | null;
  winsPerInstance: number | null;
}

export interface AliasGroup {
  signature: string;
  spellings: { code: string; label: string; params: Record<string, unknown> | null }[];
}

export interface VariantInfo {
  id: 'classic' | 'seven';
  displayName: string;
  label: string;
  n: number;
  permutationCount: number;
  targetRtp: string;
  adapterFingerprint: string;
  elements: ElementInfo[];
  bets: BetInfo[];
  claimAliases: AliasGroup[];
  roundCredit: Record<string, string | number | boolean>;
  latestResolutionLock: number;
  limits: {
    stakeQuantumChips: string;
    minLineStakeChips: string;
    maxLineStakeChips: string;
    maxTicketStakeChips: string;
    maxLinesPerTicket: number;
    maxWinMultiple: string;
    requireDistinctLines: boolean;
    stakeLadderChips: string[];
  };
  geometry: { slotPitch: number; sphereDiameter: number; chamberHeight: number };
  staggerMs: number;
}

export interface Catalogue {
  gameId: string;
  adapterVersion: string;
  moduleVersion: string;
  playPolicy: {
    minRoundCycleMs: number;
    maxRoundsPerRollingHour: number;
    realityCheckMinutes: number[];
    realityCheckRecurrenceMinutes: number;
    playerRealityCheckIntervalOptions: number[];
    realityCheckOverride: string;
    skipShortensPresentationOnly: boolean;
    autoplay: string;
  };
  playPolicyDigest: string;
  sharedChamber: Record<string, number | string | boolean>;
  choreography: {
    commitMs: number;
    chargeMs: number;
    agitateMs: number;
    fallMs: number;
    reboundMs: number;
    lineStateChangeMs: number;
    closeNeutralMs: number;
    closeCelebratedMs: number;
    stampMs: number;
    skipCompressedMs: number;
    staggerMs: { classic: number; seven: number };
  };
  variants: Record<'classic' | 'seven', VariantInfo>;
}

export interface SessionState {
  id: string;
  now: number;
  variantId: 'classic' | 'seven';
  balanceChips: string;
  balanceCredits: string;
  openingBalanceChips: string;
  stakedChips: string;
  creditedChips: string;
  netChips: string;
  elapsedMs: number;
  roundsPlayed: number;
  roundsInRollingHour: number;
  roundsRemainingInHour: number;
  commitAvailableAt: number | null;
  commitAvailableInMs: number;
  skip: boolean;
  clientSeed: string;
  limits: { sessionMinutes: number | null; lossChips: string | null };
  playerRealityCheckMinutes: number | null;
  realityCheck: {
    due: boolean;
    minute: number;
    nextMinute: number;
    elapsedMinutes: number;
    stakedChips: string;
    creditedChips: string;
    netChips: string;
  };
  openRound: {
    roundId: string;
    nonce: number;
    variantId: 'classic' | 'seven';
    seedCommitment: string;
    previousCommitment: string;
    openedAt: number;
  } | null;
}

export interface WireTranscript {
  schema: string;
  moduleVersion: string;
  gameId: string;
  adapterVersion: string;
  adapterFingerprint: string;
  variantId: string;
  roundId: string;
  clientSeed: string;
  nonce: number;
  n: number;
  permutation: number[];
  previousCommitment: string;
  seedCommitment: string;
  commitment: string;
}

export interface WireReceipt {
  schema: string;
  moduleVersion: string;
  gameId: string;
  adapterVersion: string;
  adapterFingerprint: string;
  variantId: string;
  roundId: string;
  nonce: number;
  seedCommitment: string;
  commitment: string;
  ticketDigest: string;
  settlementDigest: string;
  totalStake: string;
  credited: string;
  signerId: string;
  digest: string;
  signature: string | null;
}

export interface WireLine {
  index: number;
  code: string;
  name: string;
  tier: string;
  label: string;
  params: Record<string, unknown>;
  stakeChips: string;
  multiplierDecimal: string;
  returnIfHitChips: string;
  won: boolean | null;
  grossChips: string | null;
  lock: number | null;
}

export interface Presentation {
  outcome: 'win' | 'partial-return' | 'no-return';
  celebrate: boolean;
  headline: string;
  stakedChips: string;
  creditedChips: string;
  netChips: string;
  audio: string;
  haptic: string;
  multiplierStamp: boolean;
  balanceCountsUp: boolean;
  goldBloom: boolean;
  lineLighting: boolean;
}

export interface ResolutionTrack {
  variantId: string;
  n: number;
  lines: { index: number; code: string; name: string; label: string; lock: number; verdict: boolean }[];
  latestPossibleLock: number;
  latestUsedLock: number;
  settlementKnownAtLock: number;
  closeCarriesInformation: false;
  resolvesAtPenultimateLock: boolean;
}

export interface RoundView {
  roundId: string;
  nonce: number;
  variantId: 'classic' | 'seven';
  phase: 'COMMITTED' | 'SETTLED';
  source: 'solo' | 'lobby';
  seedCommitment: string;
  previousCommitment: string;
  openedAt: number;
  committedAt: number | null;
  clientSeed: string;
  seedRevealed: boolean;
  serverSeed: string | null;
  transcript: WireTranscript | null;
  transcriptJson: string | null;
  ticket: { ticketDigest: string; idempotencyKey: string; totalStakeChips: string } | null;
  settlement: {
    totalStakeChips: string;
    grossChips: string;
    creditedChips: string;
    netChips: string;
    capped: boolean;
  } | null;
  settlementDigest: string | null;
  receipt: WireReceipt | null;
  resolution: ResolutionTrack | null;
  presentation: Presentation | null;
  lines: WireLine[];
  balanceAfterChips: string | null;
}

export interface QuoteLine {
  code: string;
  name: string;
  tier: string;
  label: string;
  params: Record<string, unknown>;
  stakeChips: string;
  multiplierDecimal: string;
  returnIfHitChips: string;
}

export interface TicketQuote {
  variantId: string;
  lineCount: number;
  totalStakeChips: string;
  bestOutcomeChips: string;
  bestOutcomeOrder: string;
  bestOutcomeWinningLines: number;
  everyLineCanHitTogether: boolean;
  lines: QuoteLine[];
  display: { lines: string; stake: string; best: string };
}

export interface HistoryRow {
  roundId: string;
  variantId: 'classic' | 'seven';
  source: 'solo' | 'lobby';
  committedAt: number | null;
  permutation: number[] | null;
  stakeChips: string | null;
  creditedChips: string | null;
  netChips: string | null;
  celebrate: boolean;
  headline: string;
  lineCount: number;
}

export interface LobbyState {
  running: boolean;
  cadenceMs?: number;
  variantId?: 'classic' | 'seven';
  roundId?: string;
  nonce?: number;
  seedCommitment?: string;
  previousCommitment?: string;
  openedAt?: number;
  now?: number;
  closesAt?: number;
  lastAcceptedAt?: number;
  clientClosesAt?: number;
  settleAtEpochMs?: number;
  presence?: { tickets: number; claims: { code: string; params: Record<string, unknown> }[] };
}

export interface ApiError {
  code: string;
  message: string;
  path: string;
  details?: Record<string, unknown>;
}
