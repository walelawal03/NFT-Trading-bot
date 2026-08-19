// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// Never deployed for real — only ever run via eth_call with a state override
// that plants this bytecode at two throwaway addresses plus a scratch native
// balance (see src/risk/nftRoundTripProbe.js). Zero gas, no key, no funds.
//
// WHAT THIS ANSWERS that nothing else in this repo does: a mint can succeed
// and still be a total loss, because minting and exiting are two different
// permissions. The static gate in nftDangerousFunctions.js reads the bytecode
// for known seizure/lock selectors, which catches the crude version. It
// cannot catch a transfer that reverts for a reason only visible at runtime —
// an unset transfer validator, an operator allowlist nobody is on yet, a
// paused flag, a soulbound branch behind a storage bool. This actually mints
// one and actually moves it, in a single atomic call against live state.
//
// THE ORDER OF THE TWO EXIT TESTS IS DELIBERATE and is the whole design:
//
//   1. approve an operator, then have that operator call transferFrom
//   2. only if that failed, have the owner move it themselves
//
// The operator path is the one that matters, because it is what a sale
// actually is — Seaport never holds your token, it takes it through an
// approved conduit at fill time. Testing it first means a passing collection
// answers the real question. And the fallback only runs when it has to: if
// the operator path succeeded the token has moved and there is nothing left
// to test, but if it failed the token is still here, and whether the OWNER
// can move it is exactly what separates "marketplaces are blocked" (a
// transfer validator not yet configured — annoying, often temporary) from
// "nothing can move" (soulbound — the position is unexitable, permanently).
// Those two deserve different verdicts and a caller that conflates them will
// either skip good drops or buy dead ones.
//
// The operator is a SECOND COPY of this same contract at a second scratch
// address. It has to be a different address than the owner for the approval
// to mean anything; planting identical code twice is cheaper than a second
// artifact and keeps the two roles in one file.

interface IERC721 {
    function balanceOf(address owner) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function setApprovalForAll(address operator, bool approved) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256);
}

interface IProbeOperator {
    function pull(address nft, address from, address to, uint256 tokenId) external;
}

contract NftRoundTripProbe {
    // Set by onERC721Received. A drop that uses _safeMint tells us the token
    // id for free, which is the only fully reliable way to learn it — the
    // enumerable fallback below is a guess that happens to be right most of
    // the time, and reading Transfer logs is not available from inside a call.
    uint256 private receivedTokenId;
    bool private receivedAny;

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        if (!receivedAny) {
            receivedTokenId = tokenId;
            receivedAny = true;
        }
        return this.onERC721Received.selector;
    }

    // The operator half. Called by the probe on its twin, so that transferFrom
    // arrives from an address that is not the owner — the same shape as a
    // marketplace conduit moving a token it was approved for. Left to revert
    // on failure: the caller wraps it in try/catch and the revert IS the
    // signal.
    function pull(address nft, address from, address to, uint256 tokenId) external {
        IERC721(nft).transferFrom(from, to, tokenId);
    }

    // Returned as one struct rather than seven named values. Not cosmetic:
    // seven returns plus six parameters overflows the EVM's 16-slot stack
    // window and solc refuses to compile it ("stack too deep"). A memory
    // struct costs one slot. The alternative was viaIR, which changes codegen
    // for a probe whose whole value is behaving exactly like the real call.
    struct Result {
        bool mintOk;
        uint256 minted;
        uint256 tokenId;
        bool tokenIdKnown;
        bool approvalOk;
        bool operatorTransferOk;
        bool ownerTransferOk;
    }

    /**
     * Mints one and tries to get it back out.
     *
     * `mintTarget` and `mintData` come from buildMintCall, so this exercises
     * the exact call the executor would broadcast — SeaDrop's mintPublic on
     * the SeaDrop contract, or a direct mint on the collection. Anything the
     * real mint would hit, this hits.
     */
    function probe(
        address mintTarget,
        bytes calldata mintData,
        uint256 mintValue,
        address nft,
        address operator,
        address sink
    ) external returns (Result memory r) {
        uint256 balBefore;
        try IERC721(nft).balanceOf(address(this)) returns (uint256 b) {
            balBefore = b;
        } catch {
            // Not answering balanceOf means this is not an ERC-721 we can
            // reason about. Bail rather than report a verdict about a
            // contract whose shape we could not confirm.
            return r;
        }

        // Low-level, because the mint entrypoint is whatever the drop uses and
        // a typed interface would only fit the ones we guessed in advance.
        (bool ok, ) = mintTarget.call{value: mintValue}(mintData);
        if (!ok) {
            return r;
        }
        r.mintOk = true;

        uint256 balAfter;
        try IERC721(nft).balanceOf(address(this)) returns (uint256 b) {
            balAfter = b;
        } catch {
            return r;
        }
        // A mint that "succeeded" without delivering anything is its own
        // finding — the call did not revert, and nothing arrived.
        if (balAfter <= balBefore) {
            return r;
        }
        r.minted = balAfter - balBefore;

        if (receivedAny) {
            r.tokenId = receivedTokenId;
            r.tokenIdKnown = true;
        } else {
            // No hook fired, so the drop used _mint rather than _safeMint.
            // Enumerable is the only remaining way to name a token we hold.
            try IERC721(nft).tokenOfOwnerByIndex(address(this), balBefore) returns (uint256 id) {
                r.tokenId = id;
                r.tokenIdKnown = true;
            } catch {
                // Held something, cannot name it, so cannot try to move it.
                // Reported as unknown — never as a passing exit.
                return r;
            }
        }

        // ── Exit test 1: the marketplace path ────────────────────────────
        try IERC721(nft).setApprovalForAll(operator, true) {
            r.approvalOk = true;
        } catch {
            r.approvalOk = false;
        }

        if (r.approvalOk) {
            try IProbeOperator(operator).pull(nft, address(this), sink, r.tokenId) {
                // The token is gone and the question is answered. Owner
                // transfer is not attempted, and its false must be read as
                // "not tested" — the caller knows to do that only because
                // operatorTransferOk is true.
                r.operatorTransferOk = true;
                return r;
            } catch {
                r.operatorTransferOk = false;
            }
        }

        // ── Exit test 2: can the owner move it at all? ───────────────────
        // Reached only when the marketplace path failed, which means the
        // token is still here to try. safeTransferFrom rather than
        // transferFrom because this is the wallet-to-wallet exit, and the
        // sink has no code so the receiver check is a no-op.
        try IERC721(nft).safeTransferFrom(address(this), sink, r.tokenId) {
            r.ownerTransferOk = true;
        } catch {
            r.ownerTransferOk = false;
        }
    }

    receive() external payable {}
}
