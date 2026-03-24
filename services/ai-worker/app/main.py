from fastapi import FastAPI
from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional

app = FastAPI(title="Unified Tailor AI Worker", version="0.1.0")


class ResumeChunk(BaseModel):
    id: str
    section: str
    text: str
    keywords: List[str] = Field(default_factory=list)


class JobProfile(BaseModel):
    title: str = ""
    company: str = ""
    location: str = ""
    workModel: str = "unknown"
    seniority: str = "unknown"
    primaryStack: List[str] = Field(default_factory=list)
    secondaryStack: List[str] = Field(default_factory=list)
    tools: List[str] = Field(default_factory=list)
    keywords: List[str] = Field(default_factory=list)
    domain: List[str] = Field(default_factory=list)
    summary: str = ""
    hardStops: List[str] = Field(default_factory=list)
    confidence: float = 0.0


class RankRequest(BaseModel):
    jobProfile: JobProfile
    resumes: List[Dict[str, Any]] = Field(default_factory=list)


class VerifierRequest(BaseModel):
    baseResume: Dict[str, Any]
    patch: Dict[str, Any]
    jobProfile: JobProfile


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok", "service": "unified-ai-worker"}


@app.post("/contracts/rank")
def rank_contract(payload: RankRequest) -> Dict[str, Any]:
    return {
        "accepted": True,
        "resume_count": len(payload.resumes),
        "job_title": payload.jobProfile.title,
    }


@app.post("/contracts/verify")
def verify_contract(payload: VerifierRequest) -> Dict[str, Any]:
    return {
        "accepted": True,
        "job_title": payload.jobProfile.title,
        "patch_keys": sorted(payload.patch.keys()),
    }
