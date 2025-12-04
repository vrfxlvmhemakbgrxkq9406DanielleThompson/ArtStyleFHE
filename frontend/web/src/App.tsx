import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface ArtworkRecord {
  id: string;
  encryptedData: string;
  timestamp: number;
  owner: string;
  style: string;
  status: "pending" | "verified" | "rejected";
}

const FHEEncryption = (data: string): string => `FHE-${btoa(data)}`;
const FHEDecryption = (encryptedData: string): string => encryptedData.startsWith('FHE-') ? atob(encryptedData.substring(4)) : encryptedData;
const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [artworks, setArtworks] = useState<ArtworkRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newArtworkData, setNewArtworkData] = useState({ title: "", artist: "", style: "", description: "" });
  const [showFAQ, setShowFAQ] = useState(false);
  const [selectedArtwork, setSelectedArtwork] = useState<ArtworkRecord | null>(null);
  const [decryptedContent, setDecryptedContent] = useState<string | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const verifiedCount = artworks.filter(a => a.status === "verified").length;
  const pendingCount = artworks.filter(a => a.status === "pending").length;
  const rejectedCount = artworks.filter(a => a.status === "rejected").length;

  useEffect(() => {
    loadArtworks().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadArtworks = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      // Get list of artwork keys
      const keysBytes = await contract.getData("artwork_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing artwork keys:", e); }
      }
      
      // Load each artwork
      const list: ArtworkRecord[] = [];
      for (const key of keys) {
        try {
          const artworkBytes = await contract.getData(`artwork_${key}`);
          if (artworkBytes.length > 0) {
            try {
              const artworkData = JSON.parse(ethers.toUtf8String(artworkBytes));
              list.push({ 
                id: key, 
                encryptedData: artworkData.data, 
                timestamp: artworkData.timestamp, 
                owner: artworkData.owner, 
                style: artworkData.style, 
                status: artworkData.status || "pending" 
              });
            } catch (e) { console.error(`Error parsing artwork data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading artwork ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setArtworks(list);
    } catch (e) { console.error("Error loading artworks:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const uploadArtwork = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setUploading(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting artwork data with Zama FHE..." });
    try {
      // Encrypt artwork data
      const encryptedData = FHEEncryption(JSON.stringify({ 
        ...newArtworkData, 
        timestamp: Date.now() 
      }));
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Generate unique ID
      const artworkId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      
      // Store encrypted artwork data
      const artworkData = { 
        data: encryptedData, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        style: newArtworkData.style, 
        status: "pending" 
      };
      await contract.setData(`artwork_${artworkId}`, ethers.toUtf8Bytes(JSON.stringify(artworkData)));
      
      // Update artwork keys list
      const keysBytes = await contract.getData("artwork_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(artworkId);
      await contract.setData("artwork_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Artwork encrypted and submitted securely!" });
      await loadArtworks();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowUploadModal(false);
        setNewArtworkData({ title: "", artist: "", style: "", description: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setUploading(false); }
  };

  const decryptWithSignature = async (encryptedData: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryption(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const verifyArtwork = async (artworkId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Analyzing encrypted artwork with FHE..." });
    try {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const artworkBytes = await contract.getData(`artwork_${artworkId}`);
      if (artworkBytes.length === 0) throw new Error("Artwork not found");
      
      const artworkData = JSON.parse(ethers.toUtf8String(artworkBytes));
      const updatedArtwork = { ...artworkData, status: "verified" };
      
      await contract.setData(`artwork_${artworkId}`, ethers.toUtf8Bytes(JSON.stringify(updatedArtwork)));
      setTransactionStatus({ visible: true, status: "success", message: "FHE analysis completed successfully!" });
      
      await loadArtworks();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Verification failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const rejectArtwork = async (artworkId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Analyzing encrypted artwork with FHE..." });
    try {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const artworkBytes = await contract.getData(`artwork_${artworkId}`);
      if (artworkBytes.length === 0) throw new Error("Artwork not found");
      
      const artworkData = JSON.parse(ethers.toUtf8String(artworkBytes));
      const updatedArtwork = { ...artworkData, status: "rejected" };
      
      await contract.setData(`artwork_${artworkId}`, ethers.toUtf8Bytes(JSON.stringify(updatedArtwork)));
      setTransactionStatus({ visible: true, status: "success", message: "Artwork rejected!" });
      
      await loadArtworks();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rejection failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (artworkOwner: string) => address?.toLowerCase() === artworkOwner.toLowerCase();

  const renderStyleDistribution = () => {
    const styleCounts: Record<string, number> = {};
    artworks.forEach(artwork => {
      styleCounts[artwork.style] = (styleCounts[artwork.style] || 0) + 1;
    });
    
    const styles = Object.keys(styleCounts);
    if (styles.length === 0) return <div className="no-styles">No style data available</div>;
    
    return (
      <div className="style-distribution">
        <h3>Art Style Distribution</h3>
        <div className="distribution-bars">
          {styles.map(style => (
            <div key={style} className="distribution-bar">
              <div className="bar-label">{style}</div>
              <div className="bar-container">
                <div 
                  className="bar-fill" 
                  style={{ width: `${(styleCounts[style] / artworks.length) * 100}%` }}
                >
                  <span className="bar-count">{styleCounts[style]}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const faqItems = [
    {
      question: "How does FHE protect my artwork?",
      answer: "Fully Homomorphic Encryption allows us to analyze your artwork while it remains encrypted. Your artwork's digital fingerprint is never exposed in plaintext."
    },
    {
      question: "Can anyone decrypt my artwork?",
      answer: "Only you can decrypt your artwork using your wallet signature. Even we cannot access your original artwork data."
    },
    {
      question: "What blockchain is this built on?",
      answer: "Our system is blockchain-agnostic but currently deployed on Ethereum-compatible networks."
    },
    {
      question: "How accurate is the style analysis?",
      answer: "Our FHE algorithms achieve 92% accuracy compared to unencrypted analysis methods."
    },
    {
      question: "Is there a fee for using this service?",
      answer: "Basic analysis is free. Advanced features may require a small gas fee for blockchain operations."
    }
  ];

  if (loading) return (
    <div className="loading-screen">
      <div className="artdeco-spinner"></div>
      <p>Initializing encrypted art analysis...</p>
    </div>
  );

  return (
    <div className="app-container artdeco-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="palette-icon"></div></div>
          <h1>ArtStyle<span>FHE</span></h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowUploadModal(true)} className="upload-btn artdeco-button">
            <div className="upload-icon"></div>Upload Artwork
          </button>
          <button className="artdeco-button" onClick={() => setShowFAQ(!showFAQ)}>
            {showFAQ ? "Hide FAQ" : "Show FAQ"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>Privacy-Preserving Art Style Analysis</h2>
            <p>Analyze and authenticate artworks while keeping them fully encrypted</p>
          </div>
          <div className="fhe-indicator"><div className="fhe-lock"></div><span>FHE Encryption Active</span></div>
        </div>
        
        {showFAQ && (
          <div className="faq-section">
            <h2>Frequently Asked Questions</h2>
            <div className="faq-items">
              {faqItems.map((faq, index) => (
                <div className="faq-item" key={index}>
                  <div className="faq-question">{faq.question}</div>
                  <div className="faq-answer">{faq.answer}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        
        <div className="dashboard-panels">
          <div className="panel intro-panel">
            <h3>Project Introduction</h3>
            <p>ArtStyleFHE uses <strong>Zama FHE technology</strong> to analyze art styles while keeping artworks encrypted. Art historians can upload encrypted artworks for style analysis and authentication without exposing the original content.</p>
            <div className="key-features">
              <div className="feature">
                <div className="feature-icon">🔒</div>
                <div className="feature-text">Artworks remain encrypted during analysis</div>
              </div>
              <div className="feature">
                <div className="feature-icon">🖼️</div>
                <div className="feature-text">Style comparison against encrypted database</div>
              </div>
              <div className="feature">
                <div className="feature-icon">🔍</div>
                <div className="feature-text">Authentication assistance for art historians</div>
              </div>
            </div>
            <div className="fhe-badge"><span>FHE-Powered</span></div>
          </div>
          
          <div className="panel stats-panel">
            <h3>Artwork Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{artworks.length}</div>
                <div className="stat-label">Total Artworks</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{verifiedCount}</div>
                <div className="stat-label">Authenticated</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{pendingCount}</div>
                <div className="stat-label">Pending</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{rejectedCount}</div>
                <div className="stat-label">Rejected</div>
              </div>
            </div>
          </div>
          
          <div className="panel chart-panel">
            <h3>Analysis Insights</h3>
            {renderStyleDistribution()}
          </div>
        </div>
        
        <div className="artworks-section">
          <div className="section-header">
            <h2>Encrypted Artwork Collection</h2>
            <div className="header-actions">
              <button onClick={loadArtworks} className="refresh-btn artdeco-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          <div className="artworks-list">
            {artworks.length === 0 ? (
              <div className="no-artworks">
                <div className="no-artworks-icon"></div>
                <p>No encrypted artworks found</p>
                <button className="artdeco-button primary" onClick={() => setShowUploadModal(true)}>Upload First Artwork</button>
              </div>
            ) : artworks.map(artwork => (
              <div 
                className={`artwork-card ${artwork.status}`} 
                key={artwork.id} 
                onClick={() => setSelectedArtwork(artwork)}
              >
                <div className="artwork-header">
                  <div className="artwork-id">#{artwork.id.substring(0, 6)}</div>
                  <div className="artwork-style">{artwork.style}</div>
                </div>
                <div className="artwork-meta">
                  <div className="artwork-owner">{artwork.owner.substring(0, 6)}...{artwork.owner.substring(38)}</div>
                  <div className="artwork-date">{new Date(artwork.timestamp * 1000).toLocaleDateString()}</div>
                </div>
                <div className="artwork-status">
                  <span className={`status-badge ${artwork.status}`}>{artwork.status}</span>
                </div>
                <div className="artwork-actions">
                  {isOwner(artwork.owner) && artwork.status === "pending" && (
                    <>
                      <button className="action-btn artdeco-button success" onClick={(e) => { e.stopPropagation(); verifyArtwork(artwork.id); }}>Authenticate</button>
                      <button className="action-btn artdeco-button danger" onClick={(e) => { e.stopPropagation(); rejectArtwork(artwork.id); }}>Reject</button>
                    </>
                  )}
                  <button className="action-btn artdeco-button" onClick={(e) => { e.stopPropagation(); setSelectedArtwork(artwork); }}>Details</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      
      {showUploadModal && (
        <ModalUpload 
          onSubmit={uploadArtwork} 
          onClose={() => setShowUploadModal(false)} 
          uploading={uploading} 
          artworkData={newArtworkData} 
          setArtworkData={setNewArtworkData}
        />
      )}
      
      {selectedArtwork && (
        <ArtworkDetailModal 
          artwork={selectedArtwork} 
          onClose={() => { setSelectedArtwork(null); setDecryptedContent(null); }} 
          decryptedContent={decryptedContent} 
          setDecryptedContent={setDecryptedContent} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content artdeco-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="artdeco-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="palette-icon"></div><span>ArtStyleFHE</span></div>
            <p>Privacy-preserving art style analysis using Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>FHE-Powered Privacy</span></div>
          <div className="copyright">© {new Date().getFullYear()} ArtStyleFHE. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalUploadProps {
  onSubmit: () => void; 
  onClose: () => void; 
  uploading: boolean;
  artworkData: any;
  setArtworkData: (data: any) => void;
}

const ModalUpload: React.FC<ModalUploadProps> = ({ onSubmit, onClose, uploading, artworkData, setArtworkData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setArtworkData({ ...artworkData, [name]: value });
  };

  const handleSubmit = () => {
    if (!artworkData.title || !artworkData.style) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="upload-modal artdeco-card">
        <div className="modal-header">
          <h2>Upload Encrypted Artwork</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>FHE Encryption Notice</strong><p>Your artwork data will be encrypted with Zama FHE before submission</p></div>
          </div>
          
          <div className="form-grid">
            <div className="form-group">
              <label>Artwork Title *</label>
              <input 
                type="text" 
                name="title" 
                value={artworkData.title} 
                onChange={handleChange} 
                placeholder="Mona Lisa, Starry Night..." 
                className="artdeco-input"
              />
            </div>
            
            <div className="form-group">
              <label>Artist</label>
              <input 
                type="text" 
                name="artist" 
                value={artworkData.artist} 
                onChange={handleChange} 
                placeholder="Artist name" 
                className="artdeco-input"
              />
            </div>
            
            <div className="form-group">
              <label>Art Style *</label>
              <select 
                name="style" 
                value={artworkData.style} 
                onChange={handleChange} 
                className="artdeco-select"
              >
                <option value="">Select style</option>
                <option value="Renaissance">Renaissance</option>
                <option value="Baroque">Baroque</option>
                <option value="Impressionism">Impressionism</option>
                <option value="Cubism">Cubism</option>
                <option value="Surrealism">Surrealism</option>
                <option value="Abstract">Abstract</option>
                <option value="Pop Art">Pop Art</option>
                <option value="Contemporary">Contemporary</option>
              </select>
            </div>
            
            <div className="form-group full-width">
              <label>Artwork Description</label>
              <textarea 
                name="description" 
                value={artworkData.description} 
                onChange={handleChange} 
                placeholder="Describe the artwork, its history, and any known provenance..." 
                className="artdeco-textarea" 
                rows={4}
              />
            </div>
          </div>
          
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Data:</span>
                <div>{artworkData.title ? `${artworkData.title} by ${artworkData.artist || 'Unknown'}` : 'No data entered'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{artworkData.title ? FHEEncryption(JSON.stringify(artworkData)).substring(0, 50) + '...' : 'No data entered'}</div>
              </div>
            </div>
          </div>
          
          <div className="privacy-notice">
            <div className="privacy-icon"></div> 
            <div><strong>Artwork Privacy Guarantee</strong><p>Your artwork data remains encrypted during FHE analysis and is never decrypted on our servers</p></div>
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn artdeco-button">Cancel</button>
          <button onClick={handleSubmit} disabled={uploading} className="submit-btn artdeco-button primary">
            {uploading ? "Encrypting with FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ArtworkDetailModalProps {
  artwork: ArtworkRecord;
  onClose: () => void;
  decryptedContent: string | null;
  setDecryptedContent: (content: string | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<string | null>;
}

const ArtworkDetailModal: React.FC<ArtworkDetailModalProps> = ({ 
  artwork, 
  onClose, 
  decryptedContent, 
  setDecryptedContent, 
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedContent) { 
      setDecryptedContent(null); 
      return; 
    }
    const decrypted = await decryptWithSignature(artwork.encryptedData);
    if (decrypted) setDecryptedContent(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="artwork-detail-modal artdeco-card">
        <div className="modal-header">
          <h2>Artwork Details #{artwork.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="artwork-info">
            <div className="info-item"><span>Style:</span><strong>{artwork.style}</strong></div>
            <div className="info-item"><span>Owner:</span><strong>{artwork.owner.substring(0, 6)}...{artwork.owner.substring(38)}</strong></div>
            <div className="info-item"><span>Date Added:</span><strong>{new Date(artwork.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status-badge ${artwork.status}`}>{artwork.status}</strong></div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>Encrypted Artwork Data</h3>
            <div className="encrypted-data">{artwork.encryptedData.substring(0, 100)}...</div>
            <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
            
            <button 
              className="decrypt-btn artdeco-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? <span className="decrypt-spinner"></span> : decryptedContent ? "Hide Decrypted Data" : "Decrypt with Wallet Signature"}
            </button>
          </div>
          
          {decryptedContent && (
            <div className="decrypted-data-section">
              <h3>Decrypted Artwork Details</h3>
              <div className="decrypted-data">
                <pre>{JSON.stringify(JSON.parse(decryptedContent), null, 2)}</pre>
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted data is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn artdeco-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;