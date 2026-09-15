-- Phase 35A: Initial User table
-- Generated for PricePulse Supabase PostgreSQL backend.
--
-- Identity invariant: User.id === Supabase JWT.sub === Supabase Auth UUID
--
-- User.id is a TEXT primary key with no default value.
-- It is always populated from the verified Supabase JWT.sub claim.
-- No auto-generated UUID is used here — the Supabase Auth UUID is the
-- canonical identity. This design avoids a mapping table and keeps a
-- clean single-chain identity that future subscription/alert/billing
-- models will extend via foreign key on User.id.

-- CreateTable
CREATE TABLE "User" (
    "id"        TEXT         NOT NULL,
    "email"     TEXT         NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: email must be unique across all users
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
