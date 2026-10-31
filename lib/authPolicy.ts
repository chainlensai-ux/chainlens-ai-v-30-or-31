export const BANNED_PASSWORDS = new Set([
  '123456', '12345678', '123456789', 'password', 'password123',
  'qwerty', 'qwerty123', 'chainlens', 'chainlens123', 'letmein', 'admin123',
])

export const PASSWORD_POLICY_MESSAGE =
  'Use at least 10 characters with uppercase, lowercase, a number, and a symbol.'

// GoTrue stores passwords with bcrypt, which silently uses only the first 72 bytes.
// Reject longer secrets so two different passwords cannot collapse to one hash.
export const PASSWORD_MAX_BYTES = 72
export const PASSWORD_TOO_LONG_MESSAGE = 'Use 72 characters or fewer.'

export type PasswordPolicy = {
  minLen: boolean
  hasUpper: boolean
  hasLower: boolean
  hasNum: boolean
  hasSpecial: boolean
  notBanned: boolean
}

export function passwordByteLength(password: string): number {
  return new TextEncoder().encode(password).length
}

export function checkPasswordPolicy(password: string): PasswordPolicy {
  return {
    minLen: password.length >= 10 && passwordByteLength(password) <= PASSWORD_MAX_BYTES,
    hasUpper: /[A-Z]/.test(password),
    hasLower: /[a-z]/.test(password),
    hasNum: /[0-9]/.test(password),
    hasSpecial: /[^A-Za-z0-9]/.test(password),
    notBanned: !BANNED_PASSWORDS.has(password.toLowerCase()),
  }
}

export function meetsPasswordPolicy(password: unknown): password is string {
  if (typeof password !== 'string') return false
  if (passwordByteLength(password) > PASSWORD_MAX_BYTES) return false
  return Object.values(checkPasswordPolicy(password)).every(Boolean)
}

export function passwordPolicyFailure(password: unknown): string | null {
  if (typeof password !== 'string') return PASSWORD_POLICY_MESSAGE
  if (passwordByteLength(password) > PASSWORD_MAX_BYTES) return PASSWORD_TOO_LONG_MESSAGE
  if (!meetsPasswordPolicy(password)) return PASSWORD_POLICY_MESSAGE
  return null
}

export function getPasswordStrength(password: string): 'weak' | 'medium' | 'strong' {
  if (!password) return 'weak'
  const policy = checkPasswordPolicy(password)
  if (Object.values(policy).every(Boolean)) return 'strong'
  if (!policy.notBanned) return 'weak'
  const met = [policy.minLen, policy.hasUpper, policy.hasLower, policy.hasNum, policy.hasSpecial].filter(Boolean).length
  return met >= 3 ? 'medium' : 'weak'
}
