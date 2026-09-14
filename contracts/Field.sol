// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  The Field: two CA-8 dies, one RAM, one survivor.
/// @dev    "And it came to pass, when they were in the field…" — Gen 4:8
/// @notice The contract does not emulate the processors. It walks every NAND
///         of both dies, edge by edge, from a gate table deployed as code.
///         Whoever pays for a round takes that round for the side they back,
///         and the byte they send is what their champion reads on its port.
///
///         An entire match — both dies' 88 flip-flops, both memory latches,
///         both last-sponsored bytes, the round counter and the verdict —
///         lives in ONE storage slot. The battlefield is sixteen more.
///
/// Net layout (the same layout silicon/sim.js walks):
///   net 0 const 0 · net 1 const 1 · nets 2..17 mem_in · nets 18..25 in_port
///   nets 26..113 flip-flops · gate k drives net 114+k. The output column is
///   never stored, because a gate can only name wires that already exist.
///
/// Gate table blob (deployed as a data contract, read with EXTCODECOPY):
///   u16 numFFs · u16 numGates · u16 outNets[25] (mem_addr 0..7, mem_out
///   0..15, mem_we) · u16 ffD[88] · then numGates × (u16 a, u16 b).
interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

contract Field {
    // ---- the silicon ----
    address public immutable netlist;      // gate table data contract
    uint256 public immutable numGates;

    uint256 private constant NUM_FFS = 88;
    uint256 private constant HEADER = 230;          // 4 + 50 + 176
    uint256 private constant BIT_HALTED = 79;       // ff index of `halted`
    uint256 private constant BIT_OUT = 80;          // ff index of `out[0]`

    // ---- the purse ----
    IERC20 public immutable cain;
    uint256 public immutable emissionPerRound;      // paid to the sponsor, per round
    uint256 public immutable potPerRound;           // accrued to the match pot, per round
    uint256 public potOutstanding;                  // pots not yet claimed

    // ---- matches ----
    // slot bits: 0..87 stateRed · 88..175 stateBlue · 176..191 memInRed ·
    // 192..207 memInBlue · 208..215 lastByteRed · 216..223 lastByteBlue ·
    // 224..247 round · 248..255 status (0 live · 1 red · 2 blue · 3 draw)
    struct MatchMeta {
        address creator;
        uint64 createdAt;
        uint96 pot;
        uint32 redRounds;      // rounds sponsored for red
        uint32 blueRounds;
    }

    uint256 public matchCount;
    mapping(uint256 => uint256) public packedState;
    mapping(uint256 => uint256[16]) public battlefield;   // 256 words x 16 bit
    mapping(uint256 => MatchMeta) public matches;
    mapping(uint256 => mapping(uint8 => mapping(address => uint256))) public sponsoredRounds;
    mapping(uint256 => mapping(address => bool)) public claimed;

    uint256 private locked = 1;

    event MatchCreated(uint256 indexed id, address indexed creator, uint16[] red, uint16[] blue);
    event Round(
        uint256 indexed id,
        address indexed sponsor,
        uint8 side,
        uint8 inByte,
        uint32 fromRound,
        uint32 rounds,
        uint8 statusAfter,
        uint8 redOut,
        uint8 blueOut
    );
    event Finished(uint256 indexed id, uint8 result, uint32 round);
    event PotClaimed(uint256 indexed id, address indexed sponsor, uint256 amount);

    modifier nonReentrant() {
        require(locked == 1, "reentrancy");
        locked = 2;
        _;
        locked = 1;
    }

    constructor(address netlist_, address cain_, uint256 emissionPerRound_, uint256 potPerRound_) {
        netlist = netlist_;
        cain = IERC20(cain_);
        emissionPerRound = emissionPerRound_;
        potPerRound = potPerRound_;
        // read numGates out of the table rather than hardcoding the silicon
        uint256 g;
        address n = netlist_;
        assembly {
            let p := mload(0x40)
            extcodecopy(n, p, 0, 4)
            g := and(shr(240, mload(add(p, 2))), 0xffff)
        }
        numGates = g;
    }

    // -------------------------------------------------------------------
    // creating a fight
    // -------------------------------------------------------------------

    /// @notice Anyone can start a match. RED loads at word 0, BLUE at 128.
    ///         Untouched RAM is DAT, and executing DAT is death.
    function createMatch(uint16[] calldata red, uint16[] calldata blue) external returns (uint256 id) {
        require(red.length > 0 && red.length <= 128, "red: 1..128 words");
        require(blue.length > 0 && blue.length <= 128, "blue: 1..128 words");
        id = ++matchCount;

        uint256[16] storage ram = battlefield[id];
        for (uint256 i = 0; i < red.length; i++) {
            ram[i >> 4] |= uint256(red[i]) << ((i & 15) << 4);
        }
        for (uint256 i = 0; i < blue.length; i++) {
            uint256 w = i + 128;
            ram[w >> 4] |= uint256(blue[i]) << ((w & 15) << 4);
        }
        // both dies reset: every flip-flop zero except BLUE's pc = 128
        // (pc bits sit at ff index 64..71, so bit 71 of blue state = 0x80)
        uint256 packed = (uint256(0x80) << 64) << 88;
        packedState[id] = packed;
        matches[id] = MatchMeta(msg.sender, uint64(block.timestamp), 0, 0, 0);
        emit MatchCreated(id, msg.sender, red, blue);
    }

    // -------------------------------------------------------------------
    // taking rounds
    // -------------------------------------------------------------------

    /// @notice Advance a live match by up to `rounds` rounds. One round is
    ///         one edge for RED then one edge for BLUE. `side` is who you
    ///         back (0 red, 1 blue); `inByte` is what your champion reads.
    ///         No owner check, no keeper, no schedule: whoever pays, steps.
    function step(uint256 id, uint8 side, uint8 inByte, uint32 rounds) external nonReentrant {
        require(side < 2, "side");
        require(rounds > 0 && rounds <= 256, "rounds: 1..256");
        uint256 packed = packedState[id];
        require(matches[id].creator != address(0), "no such match");
        require(uint8(packed >> 248) == 0, "match over");

        // S: stateRed · stateBlue · memInRed · memInBlue · byteRed · byteBlue
        uint256[6] memory S;
        S[0] = packed & ((1 << 88) - 1);
        S[1] = (packed >> 88) & ((1 << 88) - 1);
        S[2] = (packed >> 176) & 0xffff;
        S[3] = (packed >> 192) & 0xffff;
        S[4] = (packed >> 208) & 0xff;
        S[5] = (packed >> 216) & 0xff;
        S[4 + side] = inByte;

        // battlefield into memory once for the whole batch
        uint256[16] memory ram;
        uint256[16] storage sram = battlefield[id];
        for (uint256 i = 0; i < 16; i++) ram[i] = sram[i];

        (uint32 done, uint8 status) = _run(S, ram, rounds);
        uint256 round = ((packed >> 224) & 0xffffff) + done;

        // write the battlefield and the one slot back
        for (uint256 i = 0; i < 16; i++) {
            if (sram[i] != ram[i]) sram[i] = ram[i];
        }
        packedState[id] = S[0] | (S[1] << 88) | (S[2] << 176) | (S[3] << 192)
            | (S[4] << 208) | (S[5] << 216) | (round << 224) | (uint256(status) << 248);

        _settle(id, side, inByte, done, status, round, S);
    }

    /// @dev Runs up to `rounds` rounds in memory. One round: RED's edge,
    ///      then BLUE's. Stops early on a verdict.
    function _run(uint256[6] memory S, uint256[16] memory ram, uint32 rounds)
        private view returns (uint32 done, uint8 status)
    {
        uint256 padded = (numGates + 7) & ~uint256(7);
        bytes memory tbl = new bytes(HEADER + padded * 4);
        {
            address n = netlist;
            assembly { extcodecopy(n, add(tbl, 32), 0, mload(tbl)) }
        }
        bytes memory nets = new bytes(114 + padded);
        while (done < rounds) {
            (S[0], S[2]) = _coreEdge(tbl, nets, S[0], S[2], S[4], ram);
            (S[1], S[3]) = _coreEdge(tbl, nets, S[1], S[3], S[5], ram);
            done++;
            uint256 dead = ((S[0] >> BIT_HALTED) & 1) | (((S[1] >> BIT_HALTED) & 1) << 1);
            if (dead != 0) {
                status = dead == 3 ? 3 : (dead == 2 ? 1 : 2);
                break;
            }
        }
    }

    /// @dev The books: rounds, pot, emission, events.
    function _settle(
        uint256 id, uint8 side, uint8 inByte, uint32 done, uint8 status, uint256 round, uint256[6] memory S
    ) private {
        MatchMeta storage m = matches[id];
        if (side == 0) m.redRounds += done; else m.blueRounds += done;
        sponsoredRounds[id][side][msg.sender] += done;

        uint256 potAdd = uint256(done) * potPerRound;
        uint256 reward = uint256(done) * emissionPerRound;
        uint256 free = cain.balanceOf(address(this)) - potOutstanding;
        if (potAdd > free) potAdd = free;
        m.pot += uint96(potAdd);
        potOutstanding += potAdd;
        free -= potAdd;
        if (reward > free) reward = free;
        if (reward > 0) cain.transfer(msg.sender, reward);

        emit Round(
            id, msg.sender, side, inByte,
            uint32(round - done), done, status,
            uint8((S[0] >> BIT_OUT) & 0xff), uint8((S[1] >> BIT_OUT) & 0xff)
        );
        if (status != 0) emit Finished(id, status, uint32(round));
    }

    /// @notice After the verdict: sponsors of the winning side split the pot
    ///         by rounds sponsored. A draw splits it across everyone. If the
    ///         winning side was never sponsored, everyone splits it too.
    function claimPot(uint256 id) external nonReentrant {
        uint256 packed = packedState[id];
        uint8 status = uint8(packed >> 248);
        require(status != 0, "match live");
        require(!claimed[id][msg.sender], "claimed");
        claimed[id][msg.sender] = true;

        MatchMeta storage m = matches[id];
        uint256 mine;
        uint256 total;
        if (status == 1 && m.redRounds > 0) {
            mine = sponsoredRounds[id][0][msg.sender];
            total = m.redRounds;
        } else if (status == 2 && m.blueRounds > 0) {
            mine = sponsoredRounds[id][1][msg.sender];
            total = m.blueRounds;
        } else {
            mine = sponsoredRounds[id][0][msg.sender] + sponsoredRounds[id][1][msg.sender];
            total = uint256(m.redRounds) + m.blueRounds;
        }
        require(total > 0 && mine > 0, "no share");
        uint256 amount = (uint256(m.pot) * mine) / total;
        potOutstanding -= amount;
        cain.transfer(msg.sender, amount);
        emit PotClaimed(id, msg.sender, amount);
    }

    // -------------------------------------------------------------------
    // reading the fight
    // -------------------------------------------------------------------

    function state(uint256 id)
        external
        view
        returns (
            uint32 round,
            uint8 status,
            uint8 pcRed,
            uint8 pcBlue,
            uint8 outRed,
            uint8 outBlue,
            bool haltedRed,
            bool haltedBlue,
            uint96 pot
        )
    {
        uint256 packed = packedState[id];
        uint256 stateRed = packed & ((1 << 88) - 1);
        uint256 stateBlue = (packed >> 88) & ((1 << 88) - 1);
        round = uint32((packed >> 224) & 0xffffff);
        status = uint8(packed >> 248);
        pcRed = uint8((stateRed >> 64) & 0xff);
        pcBlue = uint8((stateBlue >> 64) & 0xff);
        outRed = uint8((stateRed >> BIT_OUT) & 0xff);
        outBlue = uint8((stateBlue >> BIT_OUT) & 0xff);
        haltedRed = (stateRed >> BIT_HALTED) & 1 == 1;
        haltedBlue = (stateBlue >> BIT_HALTED) & 1 == 1;
        pot = matches[id].pot;
    }

    function ramOf(uint256 id) external view returns (uint256[16] memory out) {
        uint256[16] storage sram = battlefield[id];
        for (uint256 i = 0; i < 16; i++) out[i] = sram[i];
    }

    // -------------------------------------------------------------------
    // the machine itself
    // -------------------------------------------------------------------

    /// @dev One clock edge for one die: walk every gate, latch every
    ///      flip-flop at once, then service the memory port the way a
    ///      synchronous SRAM would — the read lands on the next edge.
    function _coreEdge(
        bytes memory tbl,
        bytes memory nets,
        uint256 state_,
        uint256 memIn,
        uint256 inByte,
        uint256[16] memory ram
    ) private pure returns (uint256 newState, uint256 newMemIn) {
        uint256 memAddr;
        uint256 memWe;
        uint256 memOut;
        assembly {
            let base := add(nets, 32)
            mstore8(base, 0)
            mstore8(add(base, 1), 1)
            for { let i := 0 } lt(i, 16) { i := add(i, 1) } {
                mstore8(add(base, add(2, i)), and(shr(i, memIn), 1))
            }
            for { let i := 0 } lt(i, 8) { i := add(i, 1) } {
                mstore8(add(base, add(18, i)), and(shr(i, inByte), 1))
            }
            for { let i := 0 } lt(i, 88) { i := add(i, 1) } {
                mstore8(add(base, add(26, i)), and(shr(i, state_), 1))
            }
            let t := add(tbl, 32)
            let nGates := and(shr(240, mload(add(t, 2))), 0xffff)
            let gptr := add(t, 230)
            // the table is padded to a multiple of 8 gates: walk 8 a stride
            let gend := add(gptr, shl(2, and(add(nGates, 7), not(7))))
            let o := add(base, 114)
            for { } lt(gptr, gend) { gptr := add(gptr, 32) o := add(o, 8) } {
                let e := shr(224, mload(gptr))
                mstore8(o, xor(and(byte(0, mload(add(base, shr(16, e)))), byte(0, mload(add(base, and(e, 0xffff))))), 1))
                e := shr(224, mload(add(gptr, 4)))
                mstore8(add(o, 1), xor(and(byte(0, mload(add(base, shr(16, e)))), byte(0, mload(add(base, and(e, 0xffff))))), 1))
                e := shr(224, mload(add(gptr, 8)))
                mstore8(add(o, 2), xor(and(byte(0, mload(add(base, shr(16, e)))), byte(0, mload(add(base, and(e, 0xffff))))), 1))
                e := shr(224, mload(add(gptr, 12)))
                mstore8(add(o, 3), xor(and(byte(0, mload(add(base, shr(16, e)))), byte(0, mload(add(base, and(e, 0xffff))))), 1))
                e := shr(224, mload(add(gptr, 16)))
                mstore8(add(o, 4), xor(and(byte(0, mload(add(base, shr(16, e)))), byte(0, mload(add(base, and(e, 0xffff))))), 1))
                e := shr(224, mload(add(gptr, 20)))
                mstore8(add(o, 5), xor(and(byte(0, mload(add(base, shr(16, e)))), byte(0, mload(add(base, and(e, 0xffff))))), 1))
                e := shr(224, mload(add(gptr, 24)))
                mstore8(add(o, 6), xor(and(byte(0, mload(add(base, shr(16, e)))), byte(0, mload(add(base, and(e, 0xffff))))), 1))
                e := shr(224, mload(add(gptr, 28)))
                mstore8(add(o, 7), xor(and(byte(0, mload(add(base, shr(16, e)))), byte(0, mload(add(base, and(e, 0xffff))))), 1))
            }
            let fdp := add(t, 54)
            newState := 0
            for { let i := 0 } lt(i, 88) { i := add(i, 1) } {
                let d := and(shr(240, mload(add(fdp, shl(1, i)))), 0xffff)
                newState := or(newState, shl(i, byte(0, mload(add(base, d)))))
            }
            let op := add(t, 4)
            memAddr := 0
            for { let i := 0 } lt(i, 8) { i := add(i, 1) } {
                let n := and(shr(240, mload(add(op, shl(1, i)))), 0xffff)
                memAddr := or(memAddr, shl(i, byte(0, mload(add(base, n)))))
            }
            memOut := 0
            for { let i := 0 } lt(i, 16) { i := add(i, 1) } {
                let n := and(shr(240, mload(add(op, add(16, shl(1, i))))), 0xffff)
                memOut := or(memOut, shl(i, byte(0, mload(add(base, n)))))
            }
            let wn := and(shr(240, mload(add(op, 48))), 0xffff)
            memWe := byte(0, mload(add(base, wn)))
        }
        uint256 slot = memAddr >> 4;
        uint256 shift = (memAddr & 15) << 4;
        if (memWe == 1) {
            ram[slot] = (ram[slot] & ~(uint256(0xffff) << shift)) | (memOut << shift);
        }
        newMemIn = (ram[slot] >> shift) & 0xffff;
    }
}
