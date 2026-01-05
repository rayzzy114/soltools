# Launch Token Tests

Comprehensive test suite for token launch functionality.

## Test Coverage

### E2E Tests (`tests/e2e/launch-token.spec.ts`)
- ✅ **Successful launch**: Dev creates token, buyers purchase tokens
- ✅ **Wallet validation**: Dev wallet as funder, buyers with correct balances
- ✅ **Balance verification**: Buyers have 0.032 SOL (exact bug report value)
- ✅ **API integration**: Proper request/response validation
- ✅ **Error handling**: Insufficient balance rejection

### Unit Tests (`tests/unit/launch-bundle.test.ts`)
- ✅ **Launch logic**: Dev creates, buyers buy correctly
- ✅ **Signer validation**: Dev as payer, all wallets as signers
- ✅ **Balance checks**: Insufficient funds detection
- ✅ **Chunking**: Multiple buyers distributed across transactions

## Running Tests

```bash
# Run all launch tests
npm run test:launch

# Run only E2E tests
npm run test:e2e:launch

# Run only unit tests
npm run test:unit tests/unit/launch-bundle.test.ts

# Run all E2E tests
npm run test:e2e
```

## Test Scenarios

### 1. Successful Launch
- Dev wallet: 0.05 SOL (sufficient for launch)
- Buyer wallets: 0.032 SOL each (exact bug report value)
- Verifies: Token creation + purchases work correctly

### 2. Insufficient Balance
- Buyer wallets: 0.002 SOL (insufficient)
- Verifies: Launch properly rejected with error message

### 3. Multiple Buyers
- 5+ buyers to test chunking logic
- Verifies: Buyers distributed across transactions correctly

## Bug Fixes Verified

✅ **Connected wallet bug**: E2E tests verify funder is Dev wallet, not Phantom
✅ **Buyer balance bug**: Tests use exact 0.032 SOL mentioned in bug report
✅ **Jito tip bug**: Tests verify proper dynamic tip calculation
✅ **Dev role bug**: Tests verify Dev creates token, buyers only purchase

## CI/CD Integration

Tests are automatically run in CI pipeline:
- Unit tests: `npm run test:unit`
- E2E tests: `npm run test:e2e`
- Launch specific: `npm run test:launch`

## Debug Information

Tests include comprehensive logging:
- Wallet balances and roles
- Transaction signers
- API request/response validation
- Error messages and failure reasons

Use `DEBUG=* npm run test:launch` for detailed logs.