import test from "node:test";
import assert from "node:assert/strict";
import { playMove } from "../lib/social.js";

const game = (kind, board) => ({kind, board, status:"active", creator_id:"a", opponent_id:"b", turn_id:"a"});

test("connect four detects both diagonal directions without wrapping rows", () => {
  const rising = Array(42).fill(0);
  for (const cell of [35,29,23]) rising[cell] = 1;
  for (const cell of [24,31,38]) rising[cell] = 2;
  const result = playMove(game("connect4",rising), "a", 3);
  assert.equal(result.status,"won"); assert.equal(result.winner_id,"a");
  const falling = Array(42).fill(0);
  for (const cell of [20,26,32]) falling[cell] = 1;
  assert.equal(playMove(game("connect4",falling),"a",3).status,"won");
  const edge = Array(42).fill(0); for (const cell of [33,34,35]) edge[cell]=1;
  assert.equal(playMove(game("connect4",edge),"a",1).status,"active");
});

test("a full column cannot overwrite a piece or change the original board", () => {
  const board = Array(42).fill(0); for(let row=0;row<6;row++) board[row*7]=row%2+1;
  const before=[...board];
  assert.throws(()=>playMove(game("connect4",board),"a",0),{status:409});
  assert.deepEqual(board,before);
});

test("tic-tac-toe finishes in a draw and rejects an occupied cell", () => {
  const state=game("tictactoe",[1,2,1,1,2,2,2,1,0]);
  const result=playMove(state,"a",8);
  assert.equal(result.status,"draw");assert.equal(result.turn_id,null);assert.equal(result.winner_id,null);
  assert.equal(state.board[8],0);
  assert.throws(()=>playMove(state,"a",0),{status:409});
});
