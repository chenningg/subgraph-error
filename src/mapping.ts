import { Address, BigDecimal, BigInt, ByteArray } from "@graphprotocol/graph-ts"
import { Approval, Transfer, ERC20 } from "../generated/ERC20/ERC20"
import { Token, Account, TokenBalance, TokenAllowance, Transaction } from "../generated/schema"

const zeroAddress = ByteArray.fromHexString("0x0000000000000000000000000000000000000000");

// Handles creation or loading of a Token entity
function loadOrCreateToken(id: Address): Token | null {
  let token = Token.load(id);

  // If no existing Token entity found, create new Token entity
  if (!token) {
    let erc20 = ERC20.bind(id);

    let nameResult = erc20.try_name();
    if (nameResult.reverted) {
      return null;
    }

    let symbolResult = erc20.try_symbol();
    if (symbolResult.reverted) {
      return null;
    }

    let decimalsResult = erc20.try_decimals();
    if (decimalsResult.reverted) {
      return null;
    }

    let totalSupplyResult = erc20.try_totalSupply();
    if (totalSupplyResult.reverted) {
      return null;
    }

    // Ignore any weird tokens to avoid overflowing the `decimals` field (which is an i32)
    // On mainnet for example there is at least one token which has a huge value for `decimals`
    // and that would overflow the Token entity's i32 field for the decimals
    if (BigDecimal.fromString(decimalsResult.value.toString()).gt(BigDecimal.fromString("255"))) {
      return null;
    }

    // If the token fulfils the ERC20 contract, create a new Token entity for it
    token = new Token(id);
    token.symbol = erc20.symbol();
    token.name = erc20.name();
    token.decimals = BigInt.fromU32(erc20.decimals());
    token.totalSupply = erc20.totalSupply();
    token.save();
  }

  return token;
}

// Handles creation or loading of an Account entity
function loadOrCreateAccount(id: Address): Account | null {
  let account = Account.load(id);

  if (!account) {
    account = new Account(id);
    account.save();
  }

  return account;
}

// Handles Approval event
export function handleApproval(event: Approval): void {
  // Check that token exists and load it
  let token = loadOrCreateToken(event.address);
  if (!token) {
    return;
  }

  let ownerAccount = loadOrCreateAccount(event.params.owner);
  let spenderAccount = loadOrCreateAccount(event.params.spender);

  // If owner or spender account does not exist, then this approval cannot occur.
  if (!ownerAccount || !spenderAccount) {
    return;
  }

  // Create a new TokenAllowance (Token ID + owner ID + spender ID = unique ID)
  // Note that we overwrite any existing TokenAllowance by creating a new one since allowance is updated
  let tokenAllowance = new TokenAllowance(token.id.concat(ownerAccount.id).concat(spenderAccount.id));
  tokenAllowance.token = token.id;
  tokenAllowance.owner = ownerAccount.id;
  tokenAllowance.spender = spenderAccount.id;
  tokenAllowance.amount = event.params.value;
  tokenAllowance.save();

  // Create a new Transaction (Block number + transaction hash + log index = unique ID)
  let transaction = new Transaction(event.block.number.toString().concat(event.transaction.hash.toHexString()).concat(event.logIndex.toString()));
  transaction.type = "APPROVAL";
  transaction.timestamp = event.block.timestamp;
  transaction.hash = event.transaction.hash;
  transaction.blockNumber = event.block.number;
  transaction.logIndex = event.logIndex;
  transaction.gasLimit = event.transaction.gasLimit;
  transaction.gasPrice = event.transaction.gasPrice;
  transaction.caller = ownerAccount.id;
  transaction.recipient = spenderAccount.id;
  transaction.value = event.transaction.value;
  transaction.amount = event.params.value;
  transaction.token = token.id;
  transaction.save();

  // Add transaction to Account
}

// Handles transfer event
export function handleTransfer(event: Transfer): void {
  // Check if token exists
  let token = loadOrCreateToken(event.address);
  if (!token) {
    return;
  }

  let fromAccount = loadOrCreateAccount(event.params.from);
  let toAccount = loadOrCreateAccount(event.params.to);

  // If either account in the form or to fields do not exist, this transaction is void
  if (!fromAccount || !toAccount) {
    return;
  }

  // If both accounts are zeroAddresses, this transaction is void
  if (fromAccount.id == zeroAddress && toAccount.id == zeroAddress) {
    return;
  }

  // If from account is NOT from zero address (aka minted), then minus from the TokenBalance from the from address
  if (fromAccount.id != zeroAddress) {
    // Check if fromTokenBalance exists
    let fromTokenBalance = TokenBalance.load(token.id.concat(fromAccount.id));

    // If no fromTokenBalance exists or the value is not enough, we need to create one, and set it to the value transferred
    if (!fromTokenBalance || fromTokenBalance.amount < event.params.value) {
      fromTokenBalance = new TokenBalance(token.id.concat(fromAccount.id));
      fromTokenBalance.account = fromAccount.id;
      fromTokenBalance.amount = event.params.value;
      fromTokenBalance.token = token.id;
    }

    // Minus the value transferred from the fromTokenBalance
    fromTokenBalance.amount = fromTokenBalance.amount.minus(event.params.value);
    fromTokenBalance.save();
  }

  // If to account is NOT the zero address (aka burnt), then add to the TokenBalance of the to address
  if (toAccount.id != zeroAddress) {
    // Check if toTokenBalance exists
    let toTokenBalance = TokenBalance.load(token.id.concat(toAccount.id));

    // If toTokenBalance doesn't exist, create it and initialize it to a zero balance
    if (!toTokenBalance) {
      toTokenBalance = new TokenBalance(token.id.concat(toAccount.id));
      toTokenBalance.account = toAccount.id;
      toTokenBalance.amount = BigInt.fromString("0");
      toTokenBalance.token = token.id;
    }

    // Update toTokenBalance to have the new balance
    toTokenBalance.amount = toTokenBalance.amount.plus(event.params.value);
    toTokenBalance.save();
  }
  
  // Create a new Transaction (Block number + transaction hash + log index = unique ID)
  let transaction = new Transaction(event.block.number.toString().concat(event.transaction.hash.toHexString()).concat(event.logIndex.toString()));
  
  // Check transaction type
  if (fromAccount.id == zeroAddress) {
    transaction.type = "MINT";
  }
  else if (toAccount.id == zeroAddress) {
    transaction.type = "BURN";
  }
  else {
    transaction.type = "TRANSFER";
  }
  
  transaction.timestamp = event.block.timestamp;
  transaction.hash = event.transaction.hash;
  transaction.blockNumber = event.block.number;
  transaction.logIndex = event.logIndex;
  transaction.gasLimit = event.transaction.gasLimit;
  transaction.gasPrice = event.transaction.gasPrice;
  transaction.caller = fromAccount.id;
  transaction.recipient = toAccount.id;
  transaction.value = event.transaction.value;
  transaction.amount = event.params.value;
  transaction.token = token.id;
  transaction.save();
}
