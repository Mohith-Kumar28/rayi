/**
 * Validate username
 *
 * Conditions:
 * - Must start with a letter
 * - Can contain letters, numbers, underscores, and periods
 * - Must be between 3 to 30 characters
 * - No consecutive special characters
 * - Cannot end with a special character
 *
 * @param {string} username
 * @returns {boolean}
 */
export function validateUsername(username: string) {
  const regex = /^[a-zA-Z](?!.*[._]{2})[a-zA-Z0-9._]{2,29}(?<![._])$/;
  return regex.test(username);
}
