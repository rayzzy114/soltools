import { Program, AnchorProvider, Idl } from "@coral-xyz/anchor"
import { Connection, PublicKey, Keypair } from "@solana/web3.js"
import { connection } from "./config"
import pumpFunIdl from "./pump_fun_idl.json"

export interface PumpFunIdl extends Idl {
  name: "pump"
}

/**
 * Load pump.fun program with IDL
 */
export function getPumpFunProgram(wallet?: Keypair): Program<PumpFunIdl> {
  const dummyKeypair = wallet || Keypair.generate()
  
  const dummyWallet = {
    publicKey: dummyKeypair.publicKey,
    signTransaction: async (tx: any) => {
      if (wallet) {
        tx.sign(wallet)
      }
      return tx
    },
    signAllTransactions: async (txs: any[]) => {
      if (wallet) {
        return txs.map((tx) => {
          tx.sign(wallet)
          return tx
        })
      }
      return txs
    },
  }

  const provider = new AnchorProvider(connection, dummyWallet as any, {
    commitment: "confirmed",
  })

  return new Program(pumpFunIdl as PumpFunIdl, provider)
}

/**
 * Get instruction accounts from IDL (helper function)
 */
export function getInstructionAccounts(instructionName: string): any[] | null {
  const idl = pumpFunIdl as PumpFunIdl
  const instruction = idl.instructions?.find((ix: any) => ix.name === instructionName)
  return instruction?.accounts || null
}

/**
 * Get instruction args from IDL (helper function)
 */
export function getInstructionArgs(instructionName: string): any[] | null {
  const idl = pumpFunIdl as PumpFunIdl
  const instruction = idl.instructions?.find((ix: any) => ix.name === instructionName)
  return instruction?.args || null
}

