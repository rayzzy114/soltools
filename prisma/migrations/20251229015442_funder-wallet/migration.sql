-- CreateTable
CREATE TABLE "FunderWallet" (
    "id" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FunderWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FunderTopup" (
    "id" TEXT NOT NULL,
    "funderWalletId" TEXT NOT NULL,
    "fromPublicKey" TEXT NOT NULL,
    "amountLamports" TEXT NOT NULL,
    "signature" TEXT,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FunderTopup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FunderWallet_publicKey_key" ON "FunderWallet"("publicKey");

-- CreateIndex
CREATE INDEX "FunderWallet_publicKey_idx" ON "FunderWallet"("publicKey");

-- CreateIndex
CREATE INDEX "FunderWallet_isActive_idx" ON "FunderWallet"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "FunderTopup_signature_key" ON "FunderTopup"("signature");

-- CreateIndex
CREATE INDEX "FunderTopup_funderWalletId_idx" ON "FunderTopup"("funderWalletId");

-- CreateIndex
CREATE INDEX "FunderTopup_fromPublicKey_idx" ON "FunderTopup"("fromPublicKey");

-- CreateIndex
CREATE INDEX "FunderTopup_createdAt_idx" ON "FunderTopup"("createdAt");

-- AddForeignKey
ALTER TABLE "FunderTopup" ADD CONSTRAINT "FunderTopup_funderWalletId_fkey" FOREIGN KEY ("funderWalletId") REFERENCES "FunderWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
