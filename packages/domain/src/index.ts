export {
  Money,
  sumMoney,
  CurrencyMismatchError,
  InvalidMoneyError,
  type MoneyJSON,
} from './money/money.js';

export {
  CURRENCY_EXPONENTS,
  UnknownCurrencyError,
  assertCurrency,
  exponentOf,
  isCurrency,
  type Currency,
} from './money/currency.js';

export {
  ConditionType,
  evaluateCondition,
  isSatisfiableAtStart,
  type DealFacts,
  type MilestoneCondition,
  type Verdict,
} from './deal/conditions.js';

export {
  evaluateDeal,
  MilestoneAmountsError,
  resolveMilestoneAmounts,
  type DealEvaluation,
  type MilestoneInput,
  type MilestoneVerdict,
} from './deal/evaluate.js';

export {
  CHECK_CATALOGUE,
  UnknownCheckError,
  checkDefinition,
  checkLabel,
  checkTier,
  isCheckName,
  type CheckDefinition,
  type CheckName,
  type CheckStatus,
  type CheckTier,
} from './checks/catalogue.js';
