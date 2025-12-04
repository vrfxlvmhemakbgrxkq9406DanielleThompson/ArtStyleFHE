// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract ArtStyleFHE is SepoliaConfig {
    struct Artwork {
        euint32 encryptedImageHash;
        euint32 encryptedStyleVector;
        euint32 encryptedArtistId;
        uint256 timestamp;
    }

    struct StyleMatch {
        euint32 encryptedSimilarityScore;
        euint32 encryptedReferenceId;
        bool isVerified;
    }

    struct ArtistProfile {
        euint32 encryptedSignatureVector;
        uint256 artworkCount;
    }

    uint256 public artworkCount;
    uint256 public artistCount;
    uint256 public analysisCount;
    mapping(uint256 => Artwork) public artworks;
    mapping(uint256 => StyleMatch) public styleMatches;
    mapping(uint256 => ArtistProfile) public artistProfiles;
    mapping(uint256 => uint256) private requestToArtworkId;
    mapping(uint256 => uint256) private requestToAnalysisId;
    
    event ArtworkSubmitted(uint256 indexed artworkId);
    event AnalysisRequested(uint256 indexed artworkId);
    event StyleMatchFound(uint256 indexed analysisId);
    event VerificationCompleted(uint256 indexed analysisId);

    function registerArtist(
        euint32 signatureVector
    ) public {
        artistCount++;
        artistProfiles[artistCount] = ArtistProfile({
            encryptedSignatureVector: signatureVector,
            artworkCount: 0
        });
    }

    function submitArtwork(
        euint32 imageHash,
        euint32 styleVector,
        euint32 artistId
    ) public {
        artworkCount++;
        artworks[artworkCount] = Artwork({
            encryptedImageHash: imageHash,
            encryptedStyleVector: styleVector,
            encryptedArtistId: artistId,
            timestamp: block.timestamp
        });
        
        if (artistId != FHE.asEuint32(0)) {
            artistProfiles[uint256(FHE.decrypt(artistId))].artworkCount++;
        }
        
        emit ArtworkSubmitted(artworkCount);
    }

    function requestStyleAnalysis(
        uint256 artworkId,
        uint256 referenceId
    ) public {
        require(artworkId <= artworkCount, "Invalid artwork");
        require(referenceId <= artworkCount, "Invalid reference");
        
        bytes32[] memory ciphertexts = new bytes32[](4);
        ciphertexts[0] = FHE.toBytes32(artworks[artworkId].encryptedStyleVector);
        ciphertexts[1] = FHE.toBytes32(artworks[referenceId].encryptedStyleVector);
        ciphertexts[2] = FHE.toBytes32(artworks[artworkId].encryptedArtistId);
        ciphertexts[3] = FHE.toBytes32(artworks[referenceId].encryptedArtistId);
        
        uint256 reqId = FHE.requestDecryption(ciphertexts, this.analyzeStyle.selector);
        requestToArtworkId[reqId] = artworkId;
        requestToAnalysisId[reqId] = referenceId;
        
        emit AnalysisRequested(artworkId);
    }

    function analyzeStyle(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        uint256 artworkId = requestToArtworkId[requestId];
        uint256 referenceId = requestToAnalysisId[requestId];
        require(artworkId != 0 && referenceId != 0, "Invalid request");

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint32[] memory vectors = abi.decode(cleartexts, (uint32[]));
        uint32[] memory styleVector1 = new uint32[](vectors.length/4);
        uint32[] memory styleVector2 = new uint32[](vectors.length/4);
        uint32 artistId1 = vectors[vectors.length/2];
        uint32 artistId2 = vectors[vectors.length/2 + 1];
        
        // Simplified similarity calculation (cosine similarity)
        uint32 similarity = 0;
        for (uint i = 0; i < styleVector1.length; i++) {
            similarity += styleVector1[i] * styleVector2[i];
        }
        
        analysisCount++;
        styleMatches[analysisCount] = StyleMatch({
            encryptedSimilarityScore: FHE.asEuint32(similarity),
            encryptedReferenceId: FHE.asEuint32(uint32(referenceId)),
            isVerified: false
        });

        // Check if same artist
        if (artistId1 == artistId2 && artistId1 != 0) {
            styleMatches[analysisCount].isVerified = true;
        }
        
        emit StyleMatchFound(analysisCount);
    }

    function verifyAuthenticity(
        uint256 analysisId,
        uint256 artistId
    ) public {
        require(analysisId <= analysisCount, "Invalid analysis");
        require(artistId <= artistCount, "Invalid artist");
        
        bytes32[] memory ciphertexts = new bytes32[](2);
        ciphertexts[0] = FHE.toBytes32(styleMatches[analysisId].encryptedSimilarityScore);
        ciphertexts[1] = FHE.toBytes32(artistProfiles[artistId].encryptedSignatureVector);
        
        uint256 reqId = FHE.requestDecryption(ciphertexts, this.checkSignature.selector);
        requestToAnalysisId[reqId] = analysisId;
    }

    function checkSignature(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        uint256 analysisId = requestToAnalysisId[requestId];
        require(analysisId != 0, "Invalid request");

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint32[] memory data = abi.decode(cleartexts, (uint32[]));
        uint32 similarityScore = data[0];
        uint32 signatureMatch = data[1];
        
        // Simplified verification logic
        bool isAuthentic = (similarityScore > 7000 && signatureMatch > 8000);
        styleMatches[analysisId].isVerified = isAuthentic;
        
        emit VerificationCompleted(analysisId);
    }

    function requestAnalysisProof(uint256 analysisId) public {
        require(analysisId <= analysisCount, "Invalid analysis");
        require(styleMatches[analysisId].isVerified, "Not verified");
        
        bytes32[] memory ciphertexts = new bytes32[](1);
        ciphertexts[0] = FHE.toBytes32(styleMatches[analysisId].encryptedSimilarityScore);
        
        uint256 reqId = FHE.requestDecryption(ciphertexts, this.decryptSimilarity.selector);
        requestToAnalysisId[reqId] = analysisId;
    }

    function decryptSimilarity(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        uint256 analysisId = requestToAnalysisId[requestId];
        require(analysisId != 0, "Invalid request");

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint32 similarity = abi.decode(cleartexts, (uint32));
        // Process decrypted similarity score
    }

    function getArtworkCount() public view returns (uint256) {
        return artworkCount;
    }

    function getVerificationStatus(uint256 analysisId) public view returns (bool) {
        return styleMatches[analysisId].isVerified;
    }

    function getArtistArtworkCount(uint256 artistId) public view returns (uint256) {
        return artistProfiles[artistId].artworkCount;
    }
}